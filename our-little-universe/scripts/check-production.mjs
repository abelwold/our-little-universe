import { loadEnv } from 'vite';

const env = loadEnv('production', process.cwd(), 'VITE_');
const required = ['VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_APP_ID'];
const missing = required.filter(name => !env[name]?.trim());
if (missing.length) {
  console.error('Set these public build variables in Netlify: ' + missing.join(', '));
  process.exitCode = 1;
} else if (env.VITE_FIREBASE_PROJECT_ID.trim().startsWith('demo-')) {
  console.error('Set VITE_FIREBASE_PROJECT_ID to the production Firebase project.');
  process.exitCode = 1;
}
