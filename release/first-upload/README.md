# First Play upload: one-time owner-key bootstrap

**Completed and archived. Do not generate a replacement upload key.**

The first owner-signed AAB passed [Actions run 40442669574](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40442669574)
at source commit `2ce5628`. Its package/version, release flags, billing
permission/library, signature certificate and all 70 original audio files were
verified. The active one-time workflow has been moved to
`first-play-upload.yml.disabled` so later pushes cannot create a different key.

Owner delivery: [first Play AAB artifact](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40442669574/artifacts/12707521425).
This is the canonical first-upload candidate; future builds must reuse its
upload key recovered from the encrypted owner backup.

Canonical upload-certificate SHA-256:
`c4d31b29444fcd6fabea9ee91a01fd6bab3383a07079302e19ff32a1d7805139`.
Encrypted CMS payload SHA-256:
`bcedc02a22a9f316c38b018b8bcdf7397c68775426b9b1b54505f2df1f2f7405`.
The actual published ciphertext was reconstructed and checksum-verified,
authenticated-decrypted outside the repository, and its recovered JKS was used
to sign and verify a temporary file. The recovered certificate matches the
certificate verified on the AAB. No credentials were printed.

Private owner delivery files are `SOUL_READER_UPLOAD_KEY_BACKUP.zip` and the
separate `SOUL_READER_BACKUP_PASSWORD.txt` in the workspace exports. These are
not repository files. The ZIP contains the actual encrypted CMS backup and an
encrypted recipient private key, with recovery instructions. The password is
never included in that ZIP or a GitHub artifact. The owner must retain both
outside this cloud workspace for future app updates.

The owner confirmed no APK/AAB has previously been uploaded for this Play app.
Package: `com.soulreader.soul_reader`; first upload version: `8.5.6+95`.

The dedicated bootstrap workflow runs only when branch
`build/first-play-upload-20261027-2` is first created, on its first run attempt.
Do not rerun or recreate the bootstrap after a successful AAB is uploaded.
Archive the workflow trigger immediately after the successful build.

The first recipe run 40442475566 failed schema validation before any job or key
generation. The corrected branch initializes runner paths in a step, after the
runner has been allocated.

Only the **public** backup-recipient certificate is committed here. Its DER
SHA-256 is recorded in `public-metadata.json`. The encrypted private decryption
key and its password remain outside this repository for the owner's private
backup download. Neither is supplied to GitHub Actions.

The runner creates the long-lived upload JKS in a private temporary directory.
It encrypts a backup containing the JKS and credentials using authenticated CMS
AES-256-GCM and RSA-OAEP-SHA256 to the public recipient. Only ciphertext is
published as an artifact and recovery annotations. No plaintext signing key,
password or signing configuration is published or cached.

Before recommending Play upload, recover the actual encrypted backup into a
private external directory, verify successful authenticated decryption, and
compare the recovered JKS certificate with the AAB's verified certificate.
Keep the encrypted backup, recipient private-key backup and its password safely
outside this cloud workspace. Artifact retention is not permanent key storage.

The final AAB must pass bundletool validation, package/version/non-debuggable
manifest checks, billing permission/library checks, JAR signature/certificate
verification, and preservation of all 70 original audio files.

This is an **internal-test payment-preparation build**. Login, the purchase
verification backend and live billing are still unconfigured. It enables the
first Play binary upload/product-registration stage; it does not complete the
production payment service.
