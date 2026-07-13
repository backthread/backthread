// Rails-style inflections: acronym camelize + English pluralize/singularize.

import { describe, it, expect } from '../testkit.js';
import {
  parseInflections,
  buildInflections,
  camelize,
  pluralize,
  singularize,
  DEFAULT_INFLECTIONS,
} from './ruby-inflect.js';

// A trimmed-down copy of Mastodon's config/initializers/inflections.rb — the real
// shape: an `inflections(:en) do |inflect| … end` block with commented examples
// above it that MUST NOT be parsed.
const MASTODON_INFLECTIONS = `# frozen_string_literal: true

# Add new inflection rules using the following format.
# ActiveSupport::Inflector.inflections(:en) do |inflect|
#   inflect.irregular "octopus", "octopi"
#   inflect.uncountable %w( fish sheep )
# end

ActiveSupport::Inflector.inflections(:en) do |inflect|
  inflect.acronym 'ActivityPub'
  inflect.acronym 'OAuth'
  inflect.acronym 'REST'
  inflect.acronym 'URL'
  inflect.irregular 'medium', 'media'
  inflect.uncountable %w( kudos )
end
`;

describe('parseInflections', () => {
  it('reads declared acronyms / irregulars / uncountables and skips commented examples', () => {
    const p = parseInflections(MASTODON_INFLECTIONS);
    expect(p.acronyms).toEqual(['ActivityPub', 'OAuth', 'REST', 'URL']);
    expect(p.irregulars).toEqual([['medium', 'media']]);
    expect(p.uncountable).toEqual(['kudos']);
    // the commented `octopus`/`fish sheep` examples must NOT leak in
    expect(p.irregulars).not.toContainEqual(['octopus', 'octopi']);
    expect(p.uncountable).not.toContain('fish');
  });

  it('handles paren + double-quote call styles', () => {
    const p = parseInflections(`inflect.acronym("API")\ninflect.uncountable "rice"\n`);
    expect(p.acronyms).toEqual(['API']);
    expect(p.uncountable).toEqual(['rice']);
  });
});

describe('camelize (acronym-aware)', () => {
  const infl = buildInflections([parseInflections(MASTODON_INFLECTIONS)]);

  it('applies ONLY declared acronyms; undeclared words camelize plainly', () => {
    expect(camelize('activitypub', infl)).toBe('ActivityPub');
    expect(camelize('inboxes_controller', infl)).toBe('InboxesController');
    expect(camelize('oauth', infl)).toBe('OAuth');
    expect(camelize('url', infl)).toBe('URL');
    // `api` is a real acronym but NOT declared in THIS repo → stays plain (acronyms
    // are repo-scoped; we never guess a casing the repo didn't declare)
    expect(camelize('api', infl)).toBe('Api');
    // an undeclared acronym stays plain — never a guessed casing
    expect(camelize('html', infl)).toBe('Html');
    expect(camelize('users_controller', infl)).toBe('UsersController');
  });

  it('applies an acronym mid-word (per underscore segment)', () => {
    expect(camelize('oauth_application', infl)).toBe('OAuthApplication');
    expect(camelize('rest_client', infl)).toBe('RESTClient');
  });

  it('with no inflections behaves like the plain camelizer', () => {
    expect(camelize('activitypub')).toBe('Activitypub');
    expect(camelize('users_controller')).toBe('UsersController');
    expect(camelize('', DEFAULT_INFLECTIONS)).toBe('');
  });
});

describe('pluralize', () => {
  it('applies the English rules', () => {
    expect(pluralize('inbox')).toBe('inboxes'); // x → +es (the naive +s gave `inboxs`)
    expect(pluralize('outbox')).toBe('outboxes');
    expect(pluralize('post')).toBe('posts');
    expect(pluralize('company')).toBe('companies'); // consonant-y → ies
    expect(pluralize('day')).toBe('days'); // vowel-y → +s
    expect(pluralize('church')).toBe('churches');
    expect(pluralize('dish')).toBe('dishes');
    expect(pluralize('bus')).toBe('buses');
    expect(pluralize('status')).toBe('statuses');
  });

  it('honors irregular + uncountable (default + declared)', () => {
    expect(pluralize('person')).toBe('people');
    expect(pluralize('child')).toBe('children');
    expect(pluralize('series')).toBe('series'); // uncountable
    const infl = buildInflections([{ acronyms: [], irregulars: [['medium', 'media']], uncountable: [] }]);
    expect(pluralize('medium', infl)).toBe('media');
  });
});

describe('singularize', () => {
  it('inverts the English rules', () => {
    expect(singularize('inboxes')).toBe('inbox'); // sibilant-es
    expect(singularize('boxes')).toBe('box');
    expect(singularize('companies')).toBe('company'); // consonant-ies → y
    expect(singularize('categories')).toBe('category');
    expect(singularize('churches')).toBe('church');
    expect(singularize('posts')).toBe('post');
    expect(singularize('comments')).toBe('comment');
    expect(singularize('media_attachments')).toBe('media_attachment');
    expect(singularize('houses')).toBe('house'); // NOT `hous`
  });

  it('honors irregular + uncountable', () => {
    expect(singularize('people')).toBe('person');
    expect(singularize('children')).toBe('child');
    expect(singularize('statuses')).toBe('status'); // NOT `statuse`
    expect(singularize('buses')).toBe('bus');
    expect(singularize('series')).toBe('series'); // uncountable
    const infl = buildInflections([{ acronyms: [], irregulars: [['medium', 'media']], uncountable: [] }]);
    expect(singularize('media', infl)).toBe('medium');
  });

  it('applies irregulars suffix-anchored on underscore compounds (Rails join names)', () => {
    // `has_many :preview_cards_statuses` → PreviewCardsStatus (NOT `…Statuse`)
    expect(singularize('preview_cards_statuses')).toBe('preview_cards_status');
    expect(singularize('account_aliases')).toBe('account_alias');
    // a `_` boundary is required, so an unrelated word isn't matched mid-string
    expect(singularize('omens')).toBe('omen'); // plain `s` strip, NOT `oman`
  });
});
