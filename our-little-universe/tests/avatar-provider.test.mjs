import assert from 'node:assert/strict';
import test from 'node:test';
import provider from '../functions/lib/avatar-provider.js';

const reference = Buffer.from([255, 216, 255, 1, 255, 217]);
const output = Buffer.from([255, 216, 255, 2, 255, 217]);

test('image edits send the input bytes and return the provider image', async t => {
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(request.body.get('model'), 'gpt-image-2.6-sunburst');
    assert.match(request.body.get('prompt'), /warm natural smile/);
    assert.deepEqual(Buffer.from(await request.body.get('image').arrayBuffer()), reference);
    assert.notEqual(request.body.get('safety_identifier'), 'test-user');
    return Response.json({ data: [{ b64_json: output.toString('base64') }] });
  });

  const image = await provider.editImage('test-key', 'test-user', reference, provider.expressionPrompt('smiling'));
  assert.deepEqual(image, output);
});

test('configuration and unreadable provider responses surface errors', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(provider.editImage('test-key', 'test-user', reference, provider.portraitPrompt), {
    code: 'failed-precondition',
  });
  fetch.mock.mockImplementation(async () => Response.json({ data: [{ b64_json: 'aW52YWxpZA==' }] }));
  await assert.rejects(provider.editImage('test-key', 'test-user', reference, provider.portraitPrompt), {
    code: 'internal',
  });
});

test('story illustrations send ordered portrait references or use text generation', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.match(url, /\/images\/edits$/);
    const files = request.body.getAll('image[]');
    assert.deepEqual(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer()))), [reference, output]);
    return Response.json({ data: [{ b64_json: output.toString('base64') }] });
  });
  await provider.editImage('test-key', 'test-user', [reference, output], 'A scene with two characters');
  fetch.mock.mockImplementation(async (url, request) => {
    assert.match(url, /\/images\/generations$/);
    assert.equal(JSON.parse(request.body).output_compression, 85);
    return Response.json({ data: [{ b64_json: output.toString('base64') }] });
  });
  await provider.editImage('test-key', 'test-user', [], 'A scene with fictional characters');
});

test('an exhausted API credit balance is distinct from request throttling', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: { type: 'insufficient_quota', code: 'credit_balance_exhausted' },
  }, { status: 429 }));
  const edit = () => provider.editImage('test-key', 'test-user', reference, provider.portraitPrompt);
  await assert.rejects(edit(), { code: 'resource-exhausted', message: /credit balance is exhausted/ });

  fetch.mock.mockImplementation(async () => Response.json({
    error: { code: 'rate_limit_exceeded' },
  }, { status: 429 }));
  await assert.rejects(edit(), { code: 'resource-exhausted', message: /limiting image requests/ });
});
