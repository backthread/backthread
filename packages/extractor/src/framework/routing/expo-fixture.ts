// (Slice 1) — a synthetic Expo Router `app/` tree, the HERMETIC gate for
// the routing extractor (no connected Expo repo exists yet, so the fixture IS the
// test). Engineered to exercise every Expo Router rule the parser must handle:
//
//   app/_layout.tsx                 [layout]  root layout (no parent)
//   app/index.tsx                   [page]    '/'        → Link '/profile/42', router.push('/home')
//   app/profile/[id].tsx            [page]    '/profile/[id]' (dynamic)
//                                             → router.push('/settings') + a DYNAMIC push (template literal)
//   app/settings/index.tsx          [page]    '/settings' (nested-folder index)
//   app/(tabs)/_layout.tsx          [layout]  group layout, parent = root layout
//   app/(tabs)/home.tsx             [page]    '/home'  (route GROUP stripped)
//                                             → <Redirect href='/'> + a DYNAMIC <Link href={dest}>
//   app/hello+api.ts                [endpoint] '/hello' (API route)
//
// Expected resolvable navEdges:
//   index → profile/[id]   (Link '/profile/42'  matches the dynamic [id] route)
//   index → (tabs)/home    (push '/home'         matches the group-stripped page)
//   profile/[id] → settings/index   (push '/settings')
//   (tabs)/home → index    (Redirect '/')
// Expected logged + skipped: 1 dynamic (profile template literal) + 1 dynamic
// (home <Link href={dest}>).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'expo-router-fixture', dependencies: { expo: '~51.0.0', 'expo-router': '^3.0.0', 'react-native': '0.74.0' } },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }, null, 2),

  'app/_layout.tsx': `
import { Stack } from 'expo-router';
export default function RootLayout() {
  return <Stack />;
}
`,
  'app/index.tsx': `
import { Link, useRouter } from 'expo-router';
export default function Index() {
  const router = useRouter();
  return (
    <>
      <Link href="/profile/42">Profile</Link>
      <button onClick={() => router.push('/home')}>Home</button>
    </>
  );
}
`,
  'app/profile/[id].tsx': `
import { useRouter, useLocalSearchParams } from 'expo-router';
export default function Profile() {
  const router = useRouter();
  const { id, next } = useLocalSearchParams<{ id: string; next: string }>();
  return (
    <>
      <button onClick={() => router.push('/settings')}>Settings</button>
      <button onClick={() => router.push(\`/profile/\${next}\`)}>Next</button>
    </>
  );
}
`,
  'app/settings/index.tsx': `
import { Text } from 'react-native';
export default function Settings() {
  return <Text>settings</Text>;
}
`,
  'app/(tabs)/_layout.tsx': `
import { Tabs } from 'expo-router';
export default function TabsLayout() {
  return <Tabs />;
}
`,
  'app/(tabs)/home.tsx': `
import { Link, Redirect } from 'expo-router';
export default function Home({ dest }: { dest: string }) {
  if (false) return <Redirect href="/" />;
  return <Link href={dest}>Elsewhere</Link>;
}
`,
  'app/hello+api.ts': `
export function GET() {
  return Response.json({ hello: 'world' });
}
`,
};

export const EXPO_FIXTURE_FILES = {
  rootLayout: 'app/_layout.tsx',
  index: 'app/index.tsx',
  profileId: 'app/profile/[id].tsx',
  settingsIndex: 'app/settings/index.tsx',
  tabsLayout: 'app/(tabs)/_layout.tsx',
  tabsHome: 'app/(tabs)/home.tsx',
  helloApi: 'app/hello+api.ts',
} as const;

/** Write the Expo Router fixture tree under `dir`. */
export async function writeExpoRouterFixture(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
}
