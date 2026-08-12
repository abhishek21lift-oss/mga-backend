#!/usr/bin/env node
'use strict';
// Prove the embedding pipeline still works after the H-01 dependency overrides.
//
//   npm run verify:embeddings
//
// Why this exists as a script rather than a test: the pipeline downloads its
// model from huggingface.co on first use, so it cannot run in CI or in a
// sandbox with restricted egress — which is exactly where the override was
// applied and could not be fully verified. Run it once on the deploy.
//
// What it checks, in the order the risk actually sits:
//
//   1. protobufjs 8 satisfies onnx-proto. The override jumped a MAJOR version
//      (6 → 8) on a package whose generated code is compiled against the
//      protobufjs runtime API. If that binding broke, this is where it shows.
//   2. An inference pass produces a vector of the right width. EMBEDDING_DIM
//      must stay 384 because migration 116 declares `vector(384)`; a model or
//      runtime change that altered it would make every insert fail.
//   3. The values are finite and normalised, so a silently-wrong tensor
//      (all zeros, NaN) is caught rather than stored.
//
// Reads nothing from and writes nothing to the database.

require('dotenv').config();

const SAMPLE = 'A personal training session for a new client.';

function ok(label, pass, detail) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return pass;
}

async function main() {
  let allGood = true;

  console.log('\n1. Dependency bindings');
  try {
    const pbVersion = require('protobufjs/package.json').version;
    allGood = ok('protobufjs resolves', true, `v${pbVersion}`) && allGood;
    allGood = ok('protobufjs is past the 9.8 advisory (>=7.5.5)',
      parseInt(pbVersion, 10) >= 8 || pbVersion >= '7.5.5', `v${pbVersion}`) && allGood;

    // The real question the major bump raises: does onnx-proto's generated
    // code still initialise against this runtime? ModelProto being a function
    // means protobufjs built the message class successfully.
    const onnx = require('onnx-proto');
    allGood = ok('onnx-proto compiles against it',
      typeof onnx.onnx?.ModelProto === 'function') && allGood;

    // Read from disk rather than require('sharp/package.json'): sharp 0.35
    // blocks './package.json' in its exports map, so the require throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. Reading the file also avoids loading a
    // heavy native module just to learn its version.
    const sharpVersion = JSON.parse(
      require('fs').readFileSync(
        require('path').join(__dirname, '..', 'node_modules', 'sharp', 'package.json'), 'utf8')
    ).version;
    const [maj, min] = sharpVersion.split('.').map(Number);
    allGood = ok('sharp is past the libvips advisories (>=0.35.0)',
      maj > 0 || min >= 35, `v${sharpVersion}`) && allGood;
  } catch (err) {
    allGood = ok('dependency bindings', false, err.message);
  }

  console.log('\n2. Inference');
  console.log('   (first run downloads the model from huggingface.co — can take a minute)');
  try {
    const { embedText, EMBEDDING_DIM } = require('../src/lib/ai/embeddings');
    const t0 = Date.now();
    const v = await embedText(SAMPLE);
    const ms = Date.now() - t0;

    allGood = ok('produced a vector', Array.isArray(v) || ArrayBuffer.isView(v), `${ms}ms`) && allGood;
    allGood = ok(`width matches the vector(${EMBEDDING_DIM}) column in migration 116`,
      v.length === EMBEDDING_DIM, `got ${v.length}`) && allGood;

    const values = Array.from(v);
    allGood = ok('all values finite', values.every(Number.isFinite)) && allGood;

    const norm = Math.sqrt(values.reduce((a, x) => a + x * x, 0));
    allGood = ok('vector is normalised', Math.abs(norm - 1) < 0.05, `L2 = ${norm.toFixed(4)}`) && allGood;

    const nonZero = values.filter((x) => x !== 0).length;
    allGood = ok('not a degenerate all-zero tensor', nonZero > EMBEDDING_DIM / 2,
      `${nonZero}/${v.length} non-zero`) && allGood;
  } catch (err) {
    allGood = ok('inference', false, err.message);
    if (/Forbidden access|ENOTFOUND|fetch failed|timed out/i.test(err.message)) {
      console.log('\n   This host cannot reach huggingface.co. That is a network');
      console.log('   restriction rather than a code fault — the embedding pipeline');
      console.log('   guards the download with a timeout for exactly this reason.');
      console.log('   Run this on the deploy, or set AI_EMBEDDING_CACHE_DIR to a');
      console.log('   directory that already holds the model.');
    }
  }

  console.log(allGood
    ? '\nEmbedding pipeline is healthy under the H-01 overrides.\n'
    : '\nSomething above failed — see the lines marked FAIL.\n');
  process.exit(allGood ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
