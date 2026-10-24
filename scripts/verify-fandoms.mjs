/**
 * Regression test for the four-world vocabulary (lib/fandoms.ts).
 *
 * The whole product reads titles into worlds through this one function, and a mistake here is
 * invisible until it is wrong in the worst way: a C-Drama filed under Hollywood, an anime labelled
 * "Series", a Korean film given an episode list. So the important test is the invariant between the
 * worlds' *catalog queries* and the *inference* used to label their results — if those two drift
 * apart, rails and labels disagree and nobody notices for a release.
 *
 * Run: node scripts/verify-fandoms.mjs
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'hallyu-fandoms-'));
try {
  execSync(`node node_modules/typescript/bin/tsc lib/fandoms.ts lib/model.ts --outDir ${out} --module esnext --target es2020 --moduleResolution bundler --skipLibCheck`, { stdio: 'inherit' });
  const { FANDOMS, FANDOM_IDS, classifyWorldFormat, isValidWorldDrama, dramaFandom, dramaFormat, formatLabel, dramaLabel, inferFormat, isFilm, runtimeLabel, fandomLine, toFandoms, contentContext, inWorlds, fandomById } = await import(pathToFileURL(join(out, 'fandoms.js')).href);

  let failures = 0;
  const ok = (name, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
    if (!cond) failures++;
  };

  // ---- 1. Language decides the world ----------------------------------------------------------
  ok('Korean series → K-Drama', inferFormat({ media: 'tv', language: 'ko' }) === 'kdrama');
  ok('KR origin country alone is enough', inferFormat({ media: 'tv', countries: ['KR'] }) === 'kdrama');
  ok('Chinese series → C-Drama', inferFormat({ media: 'tv', language: 'zh' }) === 'cdrama');
  ok('Cantonese counts as C-Drama', inferFormat({ media: 'tv', language: 'yue' }) === 'cdrama');
  ok('Japanese animated series → Anime', inferFormat({ media: 'tv', language: 'ja', genres: ['Animation', 'Fantasy'] }) === 'anime');
  ok('Japanese live-action series rejected from Anime & Hollywood', classifyWorldFormat({ media: 'tv', language: 'ja', countries: ['JP'], genres: ['Comedy', 'Romance'] }) === null);
  ok('Japanese live-action film rejected from Anime & Hollywood', classifyWorldFormat({ media: 'movie', language: 'ja', countries: ['JP'], genres: ['Melodrama'] }) === null);
  ok('US/JP English live-action film → Hollywood film', classifyWorldFormat({ media: 'movie', language: 'en', countries: ['US', 'JP'], genres: ['Action'] }) === 'hollywood-movie');
  ok('Tamil / non-Western international film rejected from Hollywood', classifyWorldFormat({ media: 'movie', language: 'ta', countries: ['IN'], genres: ['Action'] }) === null);
  ok('Spanish series rejected from Hollywood', classifyWorldFormat({ media: 'tv', language: 'es', countries: ['ES'], genres: ['Crime'] }) === null);
  ok('isValidWorldDrama rejects misclassified live-action anime row', isValidWorldDrama({ mediaType: 'tv', format: 'anime', originalLanguage: 'ja', region: 'JP', genres: ['Comedy', 'Romance'] }) === false);
  ok('English film → Hollywood film', inferFormat({ media: 'movie', language: 'en' }) === 'hollywood-movie');
  ok('English series → Hollywood series', inferFormat({ media: 'tv', language: 'en' }) === 'hollywood-series');
  ok('no language: film stays a film', inferFormat({ media: 'movie' }) === 'hollywood-movie');
  ok('no language: series stays a series', inferFormat({ media: 'tv' }) === 'hollywood-series');

  // ---- 2. The invariant: a world's own query infers back to that world -------------------------
  // Each world is read from TMDB with fixed parameters. Whatever those parameters select must be
  // filed under that same world, or the rails and the labels will disagree.
  for (const f of FANDOMS) {
    for (const q of f.queries) {
      const params = q.params;
      const inferred = inferFormat({ media: q.media, language: (params.with_original_language || '').toLowerCase(), countries: (params.with_origin_country || '').split(',').filter(Boolean) });
      const formatOk = f.formats.includes(inferred);
      // Korea's query is country-based, so a Korean *anime* is still expected to land in Anime —
      // the exception is deliberate, and only for the animation genre.
      const isAnimation = (params.with_genres || '').split(',').includes('16');
      ok(`${f.id} · ${q.media} query infers into ${f.id}`, formatOk || isAnimation);
    }
  }

  // ---- 3. Explicit format wins over inference -------------------------------------------------
  const explicit = { id: 'x', title: 'X', year: 2024, genres: [], cast: [], seasons: [], episodes: [], followerCount: 0, tone: '#000', status: 'completed', episodeCount: 0, mediaType: 'tv', format: 'cdrama', originalLanguage: 'en' };
  ok('a record that says C-Drama stays a C-Drama', dramaFormat(explicit) === 'cdrama');
  ok('…and files under the C-Drama world', dramaFandom(explicit).id === 'cdrama');

  // ---- 4. Films are films, whatever world they belong to --------------------------------------
  const koreanFilm = { ...explicit, format: 'kdrama', mediaType: 'movie', runtime: 133 };
  ok('a Korean film is still a film', isFilm(koreanFilm) === true);
  ok('…but it belongs to the K-Drama world', dramaFandom(koreanFilm).id === 'kdrama');
  ok('a series is not a film', isFilm({ ...explicit, format: 'kdrama', mediaType: 'tv' }) === false);
  ok('film runtime reads 2h 13m', runtimeLabel(133) === '2h 13m');
  ok('episode runtime reads 45 min', runtimeLabel(45) === '45 min');
  ok('no runtime is undefined', runtimeLabel(undefined) === undefined);

  // ---- 5. Labels are the ones the UI prints ---------------------------------------------------
  ok('format label: K-Drama', formatLabel('kdrama') === 'K-Drama');
  ok('format label: Anime', formatLabel('anime') === 'Anime');
  ok('format label: a Hollywood film is a Film', formatLabel('hollywood-movie') === 'Film');
  ok('format label: a Hollywood series is a Series', formatLabel('hollywood-series') === 'Series');
  ok('post context reads "Anime · Frieren"', contentContext({ ...explicit, format: 'anime', title: 'Frieren' }) === 'Anime · Frieren');
  ok('…and adds the episode when there is one', contentContext({ ...explicit, format: 'anime', title: 'Frieren' }, 8) === 'Anime · Frieren · Episode 8');
  ok('profile line joins worlds', fandomLine(['anime', 'kdrama']) === 'Anime · K-Drama');

  // ---- 6. Membership helpers ------------------------------------------------------------------
  ok('a member with no worlds follows everything', inWorlds(explicit, []) === true);
  ok('a member with worlds sees their own', inWorlds(explicit, ['cdrama']) === true);
  ok('…and not the others', inWorlds(explicit, ['anime']) === false);
  ok('junk ids are dropped from a profile', toFandoms(['anime', 'nope', 7, null]).join(',') === 'anime');
  ok('order is stable, not insertion order', toFandoms(['anime', 'kdrama']).join(',') === 'kdrama,anime');
  ok('unknown id falls back to a real world', !!fandomById('nope').id);
  ok('the four worlds are exactly four', FANDOM_IDS.length === 4);
  ok('every world has a flag, a tint and a query', FANDOMS.every((f) => f.flag && f.tint && f.queries.length > 0));

  console.log(failures ? `\n${failures} FANDOM CHECK(S) FAILED` : '\nALL FANDOM CHECKS PASSED');
  process.exitCode = failures ? 1 : 0;
} finally {
  rmSync(out, { recursive: true, force: true });
}
