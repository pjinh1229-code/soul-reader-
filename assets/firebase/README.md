The owner's updated public Android Firebase configuration is included here as
`google-services.json` for project soul-reader-a91f5, Android package
com.soulreader.soul_reader. A Web OAuth client is now present. See
docs/FIREBASE_CONNECT.md for the outstanding Play certificate verification.

The app validates its package/project and requires a Web OAuth client ID before
initializing sign-in. Google also validates the actual installed app's signing
certificate server-side; a successful build does not demonstrate real sign-in.
Do not put service-account credentials, private keys, passwords or access tokens
in this directory. This directory is bundled into the Android application.
