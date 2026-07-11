// (Slice A) — a synthetic React-Navigation app tree, shared by the RN
// adapter unit test + the contribution-step integration test (we have no
// connected RN repo yet, so the hermetic fixture IS the gate).
//
// Topology is engineered so Louvain reliably yields ≥5 distinct modules at the
// DEFAULT resolution: each feature/area is a DENSE little community (≥3 internal
// import edges), cross-area links are SINGLE weak edges, and navigation between
// screens is by STRING NAME (not import), so it never couples screens. The
// native boundary is consumed by the densest community (home) so the bridge edge
// survives at module level instead of collapsing into a self-edge.
//
//   navigation/  App + RootNavigator (+ linking, navTheme)   [navigator]
//   home/        HomeScreen (navigate('Details') + DeviceInfo.getVersion())  [screen]
//   details/     DetailsScreen (push('Settings'))            [screen]
//   settings/    SettingsScreen (navigate(<dynamic>) — logged+skipped)  [screen]
//   native/      DeviceInfo (NativeModules.*) + bridge/registry/types  [nativeModule]
//   hooks/useColorScheme  use*-named                         [hook]
//   components/PrimaryButton  PascalCase + JSX               [component]
//
// Expected SURVIVING (cross-module) framework edges: home→details, details→settings
// (nav, 'calls') and home→native (JS↔native bridge, 'calls').

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'rn-fixture',
      dependencies: {
        'react-native': '0.74.0',
        react: '18.2.0',
        '@react-navigation/native': '^6.0.0',
        '@react-navigation/native-stack': '^6.0.0',
      },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }, null, 2),

  // --- navigation (dense) ---------------------------------------------------
  'src/App.tsx': `
import { NavigationContainer } from '@react-navigation/native';
import RootNavigator from './navigation/RootNavigator';

export default function App() {
  return (
    <NavigationContainer>
      <RootNavigator />
    </NavigationContainer>
  );
}
`,
  'src/navigation/RootNavigator.tsx': `
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from '../screens/HomeScreen';
import DetailsScreen from '../screens/DetailsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import { linking } from './linking';
import { navTheme } from './navTheme';

const Stack = createNativeStackNavigator();

export default function RootNavigator() {
  void linking;
  void navTheme;
  return (
    <Stack.Navigator>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Details" component={DetailsScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}
`,
  'src/navigation/linking.ts': `
import { navTheme } from './navTheme';
export const linking = { prefixes: [navTheme.name] };
`,
  'src/navigation/navTheme.ts': `
export const navTheme = { name: 'default' };
`,

  // --- home (dense; consumes the native boundary) ---------------------------
  'src/screens/HomeScreen.tsx': `
import { useNavigation } from '@react-navigation/native';
import { fetchHome } from './home/homeApi';
import { HomeView } from './home/homeView';
import { useColorScheme } from '../hooks/useColorScheme';
import { PrimaryButton } from '../components/PrimaryButton';
import { DeviceInfo } from '../native/DeviceInfo';

export default function HomeScreen() {
  const navigation = useNavigation();
  fetchHome();
  useColorScheme();
  const version = DeviceInfo.getVersion();
  return (
    <HomeView label={version}>
      <PrimaryButton onPress={() => navigation.navigate('Details')} />
    </HomeView>
  );
}
`,
  'src/screens/home/homeApi.ts': `
import { renderHome } from './homeView';
export function fetchHome(): string {
  return renderHome();
}
`,
  'src/screens/home/homeView.tsx': `
import type { ReactNode } from 'react';
export function renderHome(): string {
  return 'home';
}
export function HomeView({ label, children }: { label: string; children: ReactNode }) {
  return <>{label}{children}</>;
}
`,
  'src/hooks/useColorScheme.ts': `
export function useColorScheme(): string {
  return 'light';
}
`,
  'src/components/PrimaryButton.tsx': `
export function PrimaryButton(props: { onPress: () => void }) {
  return <button onClick={props.onPress}>tap</button>;
}
`,

  // --- details --------------------------------------------------------------
  'src/screens/DetailsScreen.tsx': `
import { useNavigation } from '@react-navigation/native';
import { fetchDetails } from './details/detailsApi';
import { DetailsView } from './details/detailsView';

export default function DetailsScreen() {
  const navigation = useNavigation();
  fetchDetails();
  return <DetailsView onNext={() => navigation.push('Settings')} />;
}
`,
  'src/screens/details/detailsApi.ts': `
import { renderDetails } from './detailsView';
export function fetchDetails(): string {
  return renderDetails();
}
`,
  'src/screens/details/detailsView.tsx': `
export function renderDetails(): string {
  return 'details';
}
export function DetailsView(props: { onNext: () => void }) {
  return <button onClick={props.onNext}>next</button>;
}
`,

  // --- settings (dynamic nav target → logged + skipped) ---------------------
  'src/screens/SettingsScreen.tsx': `
import { useNavigation, useRoute } from '@react-navigation/native';
import { fetchSettings } from './settings/settingsApi';
import { SettingsView } from './settings/settingsView';

export default function SettingsScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  fetchSettings();
  return (
    <SettingsView onNext={() => navigation.navigate((route.params as { next: string }).next)} />
  );
}
`,
  'src/screens/settings/settingsApi.ts': `
import { renderSettings } from './settingsView';
export function fetchSettings(): string {
  return renderSettings();
}
`,
  'src/screens/settings/settingsView.tsx': `
export function renderSettings(): string {
  return 'settings';
}
export function SettingsView(props: { onNext: () => void }) {
  return <div onClick={props.onNext}>settings</div>;
}
`,

  // --- native boundary (dense; DeviceInfo is the JS↔native boundary) --------
  'src/native/DeviceInfo.ts': `
import { NativeModules } from 'react-native';
// Untyped on purpose: a typed wrapper would make consumers' method calls resolve
// to the type file, over-coupling the clusters. The bridge is the IMPORT edge.
export const DeviceInfo = NativeModules.DeviceInfoModule;
`,
  'src/native/nativeBridge.ts': `
import { DeviceInfo } from './DeviceInfo';
import type { NativeInfo } from './nativeTypes';
export const bridge: NativeInfo = DeviceInfo;
`,
  'src/native/nativeRegistry.ts': `
import { DeviceInfo } from './DeviceInfo';
import { bridge } from './nativeBridge';
export const registry = { DeviceInfo, bridge };
`,
  'src/native/nativeTypes.ts': `
export interface NativeInfo {
  getVersion(): string;
}
`,
};

export const RN_FIXTURE_FILES = {
  app: 'src/App.tsx',
  navigator: 'src/navigation/RootNavigator.tsx',
  homeScreen: 'src/screens/HomeScreen.tsx',
  detailsScreen: 'src/screens/DetailsScreen.tsx',
  settingsScreen: 'src/screens/SettingsScreen.tsx',
  deviceInfo: 'src/native/DeviceInfo.ts',
  nativeBridge: 'src/native/nativeBridge.ts',
  useColorScheme: 'src/hooks/useColorScheme.ts',
  primaryButton: 'src/components/PrimaryButton.tsx',
} as const;

/** Write the React-Navigation fixture tree under `dir`. */
export async function writeReactNavigationFixture(dir: string): Promise<void> {
  await writeAll(dir, FILES);
}

// ---------------------------------------------------------------------------
// a LAZY / dynamic-registration React-Navigation tree. Mirrors the
// pattern that dominates real, performance-minded RN apps (e.g. Bluesky): screens
// are NOT registered eagerly via `component={Identifier}` but lazily via
// `getComponent={() => …}` — an imported identifier, a `require('./x')`, or a
// dynamic `import('./x').Named` — and some names are non-string (an `as`-cast, a
// const-object lookup). One screen has a TRULY dynamic name → logged + skipped.
//
//   AppNavigator.tsx (JSX, lazy registration)
//     Home      getComponent={() => HomeScreen}                          (imported id)
//     Search    getComponent={() => require('./screens/SearchScreen').…} (relative require)
//     Profile   getComponent={() => import('./screens/ProfileScreen').…} (dynamic import)
//     MyProfile name={'MyProfile' as 'Profile'} → require ProfileScreen  (as-cast name)
//     Settings  name={ROUTES.SETTINGS} → require SettingsScreen          (const-object name)
//     Messages  name={Routes.MESSAGES} → require MessagesScreen          (enum-member name)
//     <dynamic> name={dynamicName} → SKIPPED + logged                    (computed name)
//   StaticNavigator.tsx — createNativeStackNavigator({ screens }) config:
//     Home2     HomeScreen                                               (identifier value)
//     Search2   { getComponent: () => require('./screens/SearchScreen2').… } (config object)
//
// Nav targets (string-literal navigate/push) → screen→screen 'calls' edges once
// the registry is populated:  Home→Search, Home→Profile, Home→Messages, Search→Profile.

const LAZY_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'rn-lazy-fixture',
      dependencies: {
        'react-native': '0.74.0',
        react: '18.2.0',
        '@react-navigation/native': '^6.0.0',
        '@react-navigation/native-stack': '^6.0.0',
      },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }, null, 2),

  'src/routes.ts': `
export const ROUTES = { SETTINGS: 'Settings' } as const;
`,
  'src/routesEnum.ts': `
export enum Routes {
  MESSAGES = 'Messages',
}
`,
  'src/AppNavigator.tsx': `
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from './screens/HomeScreen';
import { ROUTES } from './routes';
import { Routes } from './routesEnum';

const Stack = createNativeStackNavigator();
const dynamicName = String(Math.random());

export function AppNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Home" getComponent={() => HomeScreen} />
      <Stack.Screen name="Search" getComponent={() => require('./screens/SearchScreen').SearchScreen} />
      <Stack.Screen name="Profile" getComponent={() => import('./screens/ProfileScreen').ProfileScreen} />
      <Stack.Screen name={'MyProfile' as 'Profile'} getComponent={() => require('./screens/ProfileScreen').ProfileScreen} />
      <Stack.Screen name={ROUTES.SETTINGS} getComponent={() => require('./screens/SettingsScreen').SettingsScreen} />
      <Stack.Screen name={Routes.MESSAGES} getComponent={() => require('./screens/MessagesScreen').MessagesScreen} />
      <Stack.Screen name={dynamicName} getComponent={() => HomeScreen} />
    </Stack.Navigator>
  );
}
`,
  'src/StaticNavigator.tsx': `
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from './screens/HomeScreen';

export const StaticNavigator = createNativeStackNavigator({
  screens: {
    Home2: HomeScreen,
    Search2: { getComponent: () => require('./screens/SearchScreen2').SearchScreen2 },
  },
});
`,
  'src/screens/HomeScreen.tsx': `
import { useNavigation } from '@react-navigation/native';
export function HomeScreen() {
  const navigation = useNavigation();
  return (
    <>
      <button onClick={() => navigation.navigate('Search')}>search</button>
      <button onClick={() => navigation.navigate('MyProfile')}>me</button>
      <button onClick={() => navigation.navigate('Messages')}>messages</button>
    </>
  );
}
`,
  'src/screens/SearchScreen.tsx': `
import { useNavigation } from '@react-navigation/native';
export function SearchScreen() {
  const navigation = useNavigation();
  return <button onClick={() => navigation.navigate('Profile')}>profile</button>;
}
`,
  'src/screens/SearchScreen2.tsx': `
export function SearchScreen2() {
  return <div>search2</div>;
}
`,
  'src/screens/ProfileScreen.tsx': `
export function ProfileScreen() {
  return <div>profile</div>;
}
`,
  'src/screens/SettingsScreen.tsx': `
export function SettingsScreen() {
  return <div>settings</div>;
}
`,
  'src/screens/MessagesScreen.tsx': `
export function MessagesScreen() {
  return <div>messages</div>;
}
`,
};

export const RN_LAZY_FIXTURE_FILES = {
  appNavigator: 'src/AppNavigator.tsx',
  staticNavigator: 'src/StaticNavigator.tsx',
  homeScreen: 'src/screens/HomeScreen.tsx',
  searchScreen: 'src/screens/SearchScreen.tsx',
  searchScreen2: 'src/screens/SearchScreen2.tsx',
  profileScreen: 'src/screens/ProfileScreen.tsx',
  settingsScreen: 'src/screens/SettingsScreen.tsx',
  messagesScreen: 'src/screens/MessagesScreen.tsx',
} as const;

/** Write the lazy/dynamic React-Navigation fixture tree under `dir`. */
export async function writeLazyReactNavigationFixture(dir: string): Promise<void> {
  await writeAll(dir, LAZY_FILES);
}

// ---------------------------------------------------------------------------
// a SINGLE mega-navigator that registers many screens via PATH-ALIASED
// eager imports (`#/…`), the pattern that dominates real RN apps (Bluesky's
// `src/Navigation.tsx` registers ~78 screens this way). Two scale traps it
// reproduces, that collapsed 's grouping to ONE subsystem:
//   1. the tsconfig `paths` alias has NO baseUrl + a TRAILING COMMA, so neither
//      the in-memory Project nor a naive JSON.parse resolves `#/…` — every
//      `component={Screen}` then fell back to the navigator file itself;
//   2. ONE navigator owns every screen, so navigator-membership grouping yields
//      one group for the whole app.
// The screens live in DISTINCT feature folders (src/screens/<Feature>/… +
// src/view/screens/<Feature>.tsx), so the fix must split the mega-navigator into
// per-feature subsystems. tsconfig is written RAW (comment + trailing commas) to
// exercise the comment/trailing-comma-tolerant alias reader.
const MEGA_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'rn-mega-fixture',
      dependencies: {
        'react-native': '0.74.0',
        react: '18.2.0',
        '@react-navigation/native': '^6.0.0',
        '@react-navigation/native-stack': '^6.0.0',
      },
    },
    null,
    2,
  ),
  // RAW (not JSON.stringify) — a // comment + trailing commas, like Bluesky's.
  'tsconfig.json': `{
  // screen imports use the #/ path alias (no baseUrl) — the real-app shape.
  "compilerOptions": {
    "jsx": "react-jsx",
    "paths": {
      "#/*": ["./src/*"],
    },
  },
}
`,
  // The single mega-navigator: eager #/-aliased imports + component={Screen}.
  'src/Navigation.tsx': `
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from '#/view/screens/Home';
import { FeedsScreen } from '#/view/screens/Feeds';
import { ProfileScreen } from '#/screens/Profile';
import { SearchScreen } from '#/screens/Search';
import { MessagesScreen } from '#/screens/Messages/ChatList';
import { MessagesSettingsScreen } from '#/screens/Messages/Settings';

const Stack = createNativeStackNavigator();

export function Navigation() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Feeds" component={FeedsScreen} />
        <Stack.Screen name="Profile" component={ProfileScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Messages" component={MessagesScreen} />
        <Stack.Screen name="MessagesSettings" component={MessagesSettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
`,
  // Screens directly under a container dir → filename-as-feature (home / feeds).
  'src/view/screens/Home.tsx': `export function HomeScreen() { return <div>home</div>; }`,
  'src/view/screens/Feeds.tsx': `export function FeedsScreen() { return <div>feeds</div>; }`,
  // Screens in feature sub-folders → folder-as-feature (profile / search / messages).
  'src/screens/Profile/index.tsx': `export function ProfileScreen() { return <div>profile</div>; }`,
  'src/screens/Search/index.tsx': `export function SearchScreen() { return <div>search</div>; }`,
  // Two files share the Messages feature folder (the multi-file feature group).
  'src/screens/Messages/ChatList.tsx': `export function MessagesScreen() { return <div>chats</div>; }`,
  'src/screens/Messages/Settings.tsx': `export function MessagesSettingsScreen() { return <div>msg settings</div>; }`,
};

export const RN_MEGA_FIXTURE_FILES = {
  navigator: 'src/Navigation.tsx',
  home: 'src/view/screens/Home.tsx',
  feeds: 'src/view/screens/Feeds.tsx',
  profile: 'src/screens/Profile/index.tsx',
  search: 'src/screens/Search/index.tsx',
  messagesChatList: 'src/screens/Messages/ChatList.tsx',
  messagesSettings: 'src/screens/Messages/Settings.tsx',
} as const;

/** Write the mega-navigator (path-aliased, single navigator) fixture tree. */
export async function writeMegaNavigatorFixture(dir: string): Promise<void> {
  await writeAll(dir, MEGA_FILES);
}

const PLAIN_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'plain-ts', dependencies: { typescript: '^5.0.0' } }, null, 2),
  'src/index.ts': `
import { helper } from './lib/helper';
export function main(): string {
  return helper();
}
`,
  'src/lib/helper.ts': `
import { format } from './format';
export function helper(): string {
  return format('x');
}
`,
  'src/lib/format.ts': `
export function format(s: string): string {
  return s.toUpperCase();
}
`,
};

/** Write a plain-TS (no framework) tree under `dir` — the no-match control. */
export async function writePlainTsFixture(dir: string): Promise<void> {
  await writeAll(dir, PLAIN_FILES);
}

async function writeAll(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
}
