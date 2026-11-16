import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

export const avatarModel = 'gpt-image-2.6-sunburst';
export const avatarStyle = 'storybook-2d-v1';
export const expressions = {
  smiling: 'a warm natural smile',
  laughing: 'a joyful open laugh',
  blushing: 'a bashful expression with a soft cheek blush',
  winking: 'a playful one-eye wink',
  surprised: 'pleasant surprise with raised eyebrows',
  flirty: 'a playful, slightly mischievous smile',
  kissing: 'gently puckered lips as if blowing a kiss',
} as const;
export type Expression = keyof typeof expressions;

export const portraitPrompt = [
  'Create a polished premium 2D illustrated avatar of the person in the supplied reference photograph.',
  'Preserve the recognizable facial proportions, face shape, skin tone, eyes, nose, lips, hairstyle, hair texture, facial hair, glasses and distinctive features.',
  'Keep the same apparent age. Do not beautify, lighten, or replace distinctive features.',
  'Use expressive clean linework, soft cel shading, a warm storybook palette, and a solid muted lilac background.',
  'Create a centered, front-facing head-and-shoulders portrait with a relaxed neutral expression. One person only. No text or extra objects.',
].join(' ');

export function expressionPrompt(expression: Expression) {
  return [
    'Edit the approved 2D cartoon portrait supplied as the single identity reference.',
    'Keep the exact character design, apparent age, facial proportions, skin tone, hair, facial hair, accessories, clothing, framing, palette, linework, lighting and background.',
    'Change only the facial expression to ' + expressions[expression] + '. Keep the character recognizable. One person only. No text.',
  ].join(' ');
}

export async function editImage(
  key: string, uid: string, reference: Buffer | Buffer[], prompt: string, size: '1024x1024' | '1024x1536' = '1024x1024',
): Promise<Buffer> {
  const references = Array.isArray(reference) ? reference : [reference];
  const fields = {
    model: avatarModel, prompt, size, quality: 'high', output_format: 'jpeg',
    output_compression: '85', safety_identifier: createHash('sha256').update(uid).digest('hex'),
  };
  const multipart = new FormData();
  if (references.length) {
    references.forEach((bytes, index) => multipart.append(references.length === 1 ? 'image' : 'image[]',
      new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'reference-' + (index + 1) + '.jpg'));
    for (const [name, value] of Object.entries(fields)) multipart.set(name, value);
  }

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/images/' + (references.length ? 'edits' : 'generations'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, ...(!references.length ? { 'Content-Type': 'application/json' } : {}) },
      body: references.length ? multipart : JSON.stringify({ ...fields, output_compression: 85 }),
      signal: AbortSignal.timeout(250_000),
    });
  } catch {
    throw new HttpsError('unavailable', 'Could not reach the image provider. Try again.');
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new HttpsError('failed-precondition', 'The image provider key or model access needs to be configured.');
  }
  if (response.status === 429) {
    const details = await response.json().catch(() => null) as { error?: { code?: string; type?: string } } | null;
    const { code, type } = details?.error ?? {};
    if (code === 'credit_balance_exhausted') {
      throw new HttpsError('resource-exhausted', 'The OpenAI API credit balance is exhausted. Check API billing to resume image generation.');
    }
    if (type === 'insufficient_quota' || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
      throw new HttpsError('resource-exhausted', 'The OpenAI API project has no available quota. Check its billing and usage limits.');
    }
    throw new HttpsError('resource-exhausted', 'OpenAI is limiting image requests for this project. Try again later.');
  }
  if (response.status === 400 || response.status === 422) {
    throw new HttpsError('invalid-argument', 'The image provider rejected this request. For a portrait, try a clear photo of yourself.');
  }
  if (!response.ok) throw new HttpsError('unavailable', 'The image provider could not generate this image. Try again.');

  const result = await response.json().catch(() => null) as { data?: { b64_json?: string }[] } | null;
  const encoded = result?.data?.[0]?.b64_json;
  const image = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (!isJpeg(image) || image.length > 4_000_000) {
    throw new HttpsError('internal', 'The image provider returned an unreadable image. Try again.');
  }
  return image;
}

export function isJpeg(image: Buffer) {
  return image.length >= 4 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff &&
    image[image.length - 2] === 0xff && image[image.length - 1] === 0xd9;
}
