# Our Little Universe

A separate React and Firebase app for two partners to create illustrated emoji stories together.

## Run locally

From the `our-little-universe` directory, with Node.js 22.12 or later and Java 21 or later:

```sh
npm ci
npm ci --prefix functions
npm run build
npm run build --prefix functions
npm run emulators
```

Open [http://127.0.0.1:5010](http://127.0.0.1:5010). For hot reload, also run `npm run dev` and open [http://127.0.0.1:5181](http://127.0.0.1:5181). Leave the Vite Firebase environment variables unset for emulator use. Create two accounts in separate browser profiles to try the invitation. Accounts and rooms reset when emulators restart.

With the emulators (including Storage) running, execute `node --test tests/rooms.test.mjs` to verify competitive invite acceptance, membership and write restrictions, turn handling, and story/account deletion. Tests create disposable accounts and private objects in the emulators.

After building Functions, run `node --test tests/avatar-provider.test.mjs` to check that the image adapter sends the reference bytes and handles provider errors. This test does not call OpenAI.

## Production: Firebase backend and Netlify frontend

Use a dedicated Firebase project. In the Firebase console, enable email/password Authentication with a password policy and email enumeration protection, create the default Firestore database, enable Blaze, and provision a private Cloud Storage bucket. Register a Firebase web app. For a production build on your machine, copy the web configuration fields into `.env.local` using `.env.example`. Never put the OpenAI key into a Vite variable.

```sh
npx --yes firebase-tools@15.34.0 login
```

Avatar generation uses OpenAI GPT Image 2.6 Sunburst through the [Images Edit API](https://developers.openai.com/api/reference/resources/images/methods/edit). You need an OpenAI API project with billing and access to that model. The browser resizes one consented JPEG, PNG, or WebP photo (up to 8 MB) and strips its metadata before sending it through the backend. The app sends that copy to OpenAI and stores only the generated art and version metadata. OpenAI handles the request under its [API data controls](https://developers.openai.com/api/docs/guides/your-data).

For a local run, create the ignored file `functions/.secret.local` with `OPENAI_API_KEY=your_key_here`, then restart the emulators. The Storage emulator receives the generated images. To run without a provider, set `OPENAI_API_KEY=` in the same file. The avatar page reports that generation needs configuration, and the other app features remain available.

For deployment, enable Cloud Storage for Firebase, add `AVATAR_BUCKET=your-bucket-name` to `functions/.env.YOUR_PROJECT_ID`, and allow the Functions runtime service account to create, read, list, and delete objects in that bucket. Keep the bucket private. Run the following from the app directory:

```sh
npx --yes firebase-tools@15.34.0 functions:secrets:set OPENAI_API_KEY --project YOUR_PROJECT_ID
npm ci --prefix functions
npx --yes firebase-tools@15.34.0 deploy --only functions,firestore,storage --project YOUR_PROJECT_ID
```

Use **Set up your avatar** in your room to select, preview, and approve a starter avatar. Starter avatars require no photo, image provider, or API credits. When you want a photo portrait, open **Use a photo later** and generate a new version. Each approved photo version preserves its base portrait. Open **Expressions** on a photo version to generate the seven edits from that exact portrait. A partial pack can be resumed without regenerating completed expressions. Each edit counts as one provider request. Deleting a version removes its portrait and all its expressions. Earlier sample versions can still be deleted.

In Netlify, import the intended GitHub repository and choose the release branch. The root `netlify.toml` sets the app directory, production build, publish folder, SPA fallback and headers. Set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` to the Firebase web app's public configuration. Add the deployed hostname to Firebase Authentication → Settings → Authorized domains and restrict the Firebase web key to your intended sites without blocking Firebase APIs. Keep production credentials and configuration separate from previews; deploy previews should use a separate Firebase project if enabled.

Review Firebase and OpenAI usage limits and configure billing alerts before inviting users. Production AI requests require a verified email address. The backend keeps daily per-room limits for scenes and drafts. Both partners must opt in before the app sends their timeline for AI interpretation. Photos are sent only after opt-in; downloaded PNG files are outside the app’s deletion controls.

After deploy, test with two separate browser profiles and verify their email addresses. Exercise room creation, invite acceptance, turn synchronization, reload, both review approvals, AI story drafting, real portrait and expressions, postcard and comic generation, storybook reactions and downloads, and room closure. Check that a third account cannot access the room or generated art. Use disposable accounts to verify story deletion, account deletion, and access revocation. Check the Functions runtime has Firebase Authentication Admin permissions and document Cloud Storage soft-delete and backup retention separately from removal in the app. Check a mobile device, a desktop browser and both Firebase and Netlify logs.

## Features

1. **Foundation** — landing, email/password sign-up and sign-in, room routing, authenticated room creation, 24-hour single-use invitations, live partner status, and room closure. Cloud Functions enforce membership changes in transactions. Firestore rules allow only member reads and keep direct writes and invitation documents private.
2. **Avatar system** — photo-reference generation, private image storage, review, regeneration, versioning, expression generation, and deletion are implemented. Live rendering requires a configured OpenAI API key and storage. The approved portrait is available as a versioned reference for the future scene service.
3. **Core game** — open **Build a story** from a paired room. Pick a theme, mood, and 3, 5, or 7 turns per person. Alternate turns using up to three emoji, avatar, or action tiles and an optional caption. Both players see the same timeline, can return later, and can start another story after completing it. Completed stories remain stored for the future storybook.
4. **Story review** — build an editable draft from the timeline or ask OpenAI to interpret it after both partners give permission. Either partner can edit the title, story, or ending. Edits reset approvals, and the story becomes final when both partners approve the same revision.
5. **Illustration generation** — after both players approve a story and choose a character, either can generate a single illustration through OpenAI. Both can follow progress and retry a failed request. Each partner can select a saved expression on their approved photo avatar. The selected expression image or the original portrait is used as a private reference. Starter avatars and fictional characters work without photo references. Generation uses the existing OpenAI API credits and Storage configuration.
6. **Storybook and comics** — illustrated stories appear automatically in the private storybook. After creating a postcard, either partner can generate a three-panel comic using the same approved story and character choices. Both versions can be downloaded as dated, titled PNGs. Partners can react, filter their favorites, and continue or remix an approved story.
7. **Account and updates** — request password resets and verification emails, manage avatar versions, and see private updates about your room.
8. **Deletion** — either partner can delete a shared story from its detail page, including by choosing **Manage shared story** from the active game. This removes the story and artwork for both partners and strips copied chapter summaries from continuations. **Account → Delete account** requires the current password and removes sign-in, avatar art, preferences, and all current and former shared rooms with their content. The backend keeps a private account-removal marker to block unexpired sessions. Downloads already saved by either partner and data retained by providers under their retention policies are outside these controls.
