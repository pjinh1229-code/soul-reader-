"""Release signing safety checks; fixtures contain no real signing key."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/configure_release_signing.py"
SPEC = importlib.util.spec_from_file_location("configure_release_signing", SCRIPT)
signing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(signing)

# Official Flutter stable Android Kotlin template, with configured project/SDKs.
FLUTTER_TEMPLATE = '''plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.soulreader.soul_reader"
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.soulreader.soul_reader"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

'''


class ReleaseSigningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / "project"
        self.build = self.root / "android/app/build.gradle.kts"
        self.build.parent.mkdir(parents=True)
        self.build.write_text(FLUTTER_TEMPLATE)
        self.build.chmod(0o644)
        self.properties = self.root / "android/key.properties"
        self.key = self.directory / "outside-upload.jks"
        self.key.write_bytes(b"not a real key; fixture existence only")
        self.env = {
            "SOUL_UPLOAD_KEYSTORE_PATH": str(self.key),
            "SOUL_UPLOAD_KEYSTORE_PASSWORD": "fixture-store-secret",
            "SOUL_UPLOAD_KEY_ALIAS": "fixture-alias",
            "SOUL_UPLOAD_KEY_PASSWORD": "fixture-key-secret",
        }

    def run_main(self, environ=None):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            status = signing.main(self.root, self.env if environ is None else environ)
        return status, output.getvalue() + errors.getvalue()

    def assert_no_mutation(self):
        self.assertEqual(self.build.read_text(), FLUTTER_TEMPLATE)
        self.assertFalse(self.properties.exists())

    def test_missing_each_setting_fails_without_mutation_or_secret_output(self):
        for name in signing.REQUIRED_ENV:
            with self.subTest(setting=name):
                environ = dict(self.env)
                del environ[name]
                status, output = self.run_main(environ)
                self.assertEqual(status, 1)
                for value in self.env.values():
                    self.assertNotIn(value, output)
                self.assert_no_mutation()

    def test_empty_values_and_cr_lf_null_are_rejected_before_mutation(self):
        for name in signing.REQUIRED_ENV:
            for value in ("", "private\nvalue", "private\rvalue", "private\0value"):
                with self.subTest(setting=name, invalid=repr(value)):
                    environ = dict(self.env, **{name: value})
                    status, output = self.run_main(environ)
                    self.assertEqual(status, 1)
                    self.assertNotIn("private", output)
                    self.assert_no_mutation()

    def test_relative_missing_and_inside_checkout_keystores_fail(self):
        inside = self.root / "upload.jks"
        inside.write_bytes(b"not a real key")
        for path in ("relative.jks", str(self.directory / "missing.jks"), str(inside)):
            with self.subTest(path=path):
                status, output = self.run_main(dict(self.env, SOUL_UPLOAD_KEYSTORE_PATH=path))
                self.assertEqual(status, 1)
                self.assertNotIn(path, output)
                self.assert_no_mutation()

    def test_unknown_template_preserves_both_existing_files(self):
        unknown = FLUTTER_TEMPLATE.replace('getByName("debug")', 'getByName("custom")')
        self.build.write_text(unknown)
        self.properties.write_text("existing-properties")
        status, output = self.run_main()
        self.assertEqual(status, 1)
        self.assertIn("Unsupported", output)
        self.assertEqual(self.build.read_text(), unknown)
        self.assertEqual(self.properties.read_text(), "existing-properties")

    def test_additional_signing_override_fails_closed(self):
        self.build.write_text(FLUTTER_TEMPLATE + '\nsigningConfig = signingConfigs.getByName("other")\n')
        before = self.build.read_bytes()
        status, _ = self.run_main()
        self.assertEqual(status, 1)
        self.assertEqual(self.build.read_bytes(), before)
        self.assertFalse(self.properties.exists())

    def test_repeatable_configuration_has_no_debug_fallback_and_preserves_flags(self):
        self.assertEqual(self.run_main()[0], 0)
        first_gradle, first_properties = self.build.read_bytes(), self.properties.read_bytes()
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.build.read_bytes(), first_gradle)
        self.assertEqual(self.properties.read_bytes(), first_properties)
        source = first_gradle.decode()
        self.assertIn('signingConfig = signingConfigs.getByName("soulUpload")', source)
        self.assertNotIn('getByName("debug")', source)
        self.assertNotIn("debug keys", source)
        self.assertIn("minSdk = 24", source)
        self.assertIn("compileSdk = 36", source)
        self.assertIn("sourceCompatibility = JavaVersion.VERSION_17", source)
        self.assertIn('source = "../.."', source)
        for value in self.env.values():
            self.assertNotIn(value, source)
        self.assertEqual(stat.S_IMODE(self.properties.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.build.stat().st_mode), 0o644)
        self.assertFalse(list(self.properties.parent.glob(".key.properties.*")))
        self.assertFalse(list(self.build.parent.glob(".build.gradle.kts.*")))

    def test_modified_managed_block_fails_without_overwriting(self):
        self.assertEqual(self.run_main()[0], 0)
        changed = self.build.read_text().replace('getByName("soulUpload")', 'getByName("debug")')
        self.build.write_text(changed)
        before_properties = self.properties.read_bytes()
        status, _ = self.run_main()
        self.assertEqual(status, 1)
        self.assertEqual(self.build.read_text(), changed)
        self.assertEqual(self.properties.read_bytes(), before_properties)

    def test_properties_permissions_are_corrected_on_repeated_run(self):
        self.assertEqual(self.run_main()[0], 0)
        self.properties.chmod(0o644)
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(stat.S_IMODE(self.properties.stat().st_mode), 0o600)

    def test_symlink_properties_cannot_write_outside_android(self):
        outside = self.directory / "must-not-change"
        outside.write_text("unchanged")
        self.properties.symlink_to(outside)
        status, _ = self.run_main()
        self.assertEqual(status, 1)
        self.assertEqual(outside.read_text(), "unchanged")
        self.assertEqual(self.build.read_text(), FLUTTER_TEMPLATE)

    @unittest.skipUnless(shutil.which("java"), "Java is needed to verify Properties.load compatibility")
    def test_properties_round_trip_with_real_java_parser(self):
        self.key.unlink()
        self.key = self.directory / '외부 key \\ "quoted" =#!😀.jks'
        self.key.write_bytes(b"not a real key")
        special = ' leading space \\ "quoted" =:#!\t끝😀'
        self.env.update({
            "SOUL_UPLOAD_KEYSTORE_PATH": str(self.key),
            "SOUL_UPLOAD_KEYSTORE_PASSWORD": special,
            "SOUL_UPLOAD_KEY_ALIAS": ' alias\\" #=끝',
            "SOUL_UPLOAD_KEY_PASSWORD": special + " trailing ",
        })
        status, output = self.run_main()
        self.assertEqual(status, 0)
        for value in self.env.values():
            self.assertNotIn(value, output)
        # Java source-file mode needs no javac and compares values without printing them.
        java_source = self.directory / "CheckProperties.java"
        java_source.write_text('''import java.nio.file.*;
import java.util.*;
public class CheckProperties {
  public static void main(String[] args) throws Exception {
    Properties values = new Properties();
    try (var input = Files.newInputStream(Path.of(args[0]))) { values.load(input); }
    String[] keys = {"storeFile", "storePassword", "keyAlias", "keyPassword"};
    String[] env = {"SOUL_UPLOAD_KEYSTORE_PATH", "SOUL_UPLOAD_KEYSTORE_PASSWORD", "SOUL_UPLOAD_KEY_ALIAS", "SOUL_UPLOAD_KEY_PASSWORD"};
    for (int i = 0; i < keys.length; i++) {
      if (!Objects.equals(values.getProperty(keys[i]), System.getenv(env[i]))) {
        throw new AssertionError("Properties round-trip mismatch");
      }
    }
    System.out.println("Java Properties round-trip passed");
  }
}
''')
        result = subprocess.run(
            [shutil.which("java"), str(java_source), str(self.properties)],
            env={**os.environ, **self.env}, capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("round-trip passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
