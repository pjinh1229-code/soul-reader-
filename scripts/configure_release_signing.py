#!/usr/bin/env python3
"""Configure generated Android release signing without embedding secrets in code.

Run after prepare_android.sh. The upload keystore remains outside the checkout;
only the ignored android/key.properties contains its path and credentials.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from collections.abc import Mapping


REQUIRED_ENV = (
    "SOUL_UPLOAD_KEYSTORE_PATH",
    "SOUL_UPLOAD_KEYSTORE_PASSWORD",
    "SOUL_UPLOAD_KEY_ALIAS",
    "SOUL_UPLOAD_KEY_PASSWORD",
)
IMPORT = "import java.util.Properties\n\n"
LOADER = """// SOUL READER upload signing: begin managed properties loader.
val soulUploadProperties = Properties().apply {
    val propertiesFile = rootProject.file("key.properties")
    require(propertiesFile.isFile) { "SOUL READER upload signing properties are missing." }
    propertiesFile.inputStream().use { load(it) }
}

fun soulUploadProperty(name: String): String =
    requireNotNull(soulUploadProperties.getProperty(name)?.takeIf { it.isNotEmpty() }) {
        "SOUL READER upload signing property is missing."
    }
// SOUL READER upload signing: end managed properties loader.

"""
DEFAULT_BUILD_TYPES = """    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
"""
SIGNED_BUILD_TYPES = """    // SOUL READER upload signing: begin managed signing configuration.
    signingConfigs {
        create("soulUpload") {
            storeFile = file(soulUploadProperty("storeFile"))
            storePassword = soulUploadProperty("storePassword")
            keyAlias = soulUploadProperty("keyAlias")
            keyPassword = soulUploadProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("soulUpload")
        }
    }
    // SOUL READER upload signing: end managed signing configuration.
"""


class SigningConfigurationError(Exception):
    """A safe, credential-free error suitable for CI output."""


def _properties_value(value: str) -> str:
    """Escape a value for Java Properties.load(InputStream), which uses Latin-1."""
    escaped = []
    for character in value:
        if character in "\\ :=#!":
            escaped.append("\\" + character)
        elif character == "\t":
            escaped.append("\\t")
        elif character == "\f":
            escaped.append("\\f")
        elif ord(character) < 32 or ord(character) >= 127:
            units = character.encode("utf-16-be", errors="surrogatepass")
            escaped.extend(
                f"\\u{int.from_bytes(units[index:index + 2], 'big'):04x}"
                for index in range(0, len(units), 2)
            )
        else:
            escaped.append(character)
    return "".join(escaped)


def _render_plain_gradle(source: str) -> str:
    """Accept only Flutter's known generated signing layout; never guess."""
    if (
        not source.startswith("plugins {\n")
        or source.count("\n\nandroid {\n") != 1
        or source.count(DEFAULT_BUILD_TYPES) != 1
    ):
        raise SigningConfigurationError("Unsupported generated Android signing template.")
    remainder = source.replace(DEFAULT_BUILD_TYPES, "", 1)
    if re.search(r"\b(?:signingConfig|signingConfigs|soulUpload\w*)\b", remainder):
        raise SigningConfigurationError("Unsupported generated Android signing template.")
    if not re.match(r"plugins \{.*?\n\}\n\nandroid \{\n", source, re.DOTALL):
        raise SigningConfigurationError("Unsupported generated Android signing template.")
    result = source.replace("\n\nandroid {\n", "\n\n" + LOADER + "android {\n", 1)
    result = result.replace(DEFAULT_BUILD_TYPES, SIGNED_BUILD_TYPES, 1)
    return IMPORT + result


def _render_gradle(source: str) -> str:
    if "SOUL READER upload signing:" not in source and "soulUpload" not in source:
        return _render_plain_gradle(source)
    if (
        not source.startswith(IMPORT)
        or source.count(LOADER) != 1
        or source.count(SIGNED_BUILD_TYPES) != 1
    ):
        raise SigningConfigurationError("Unsupported managed Android signing template.")
    plain = source[len(IMPORT):].replace(LOADER, "", 1)
    plain = plain.replace(SIGNED_BUILD_TYPES, DEFAULT_BUILD_TYPES, 1)
    if _render_plain_gradle(plain) != source:
        raise SigningConfigurationError("Unsupported managed Android signing template.")
    return source


def _atomic_write(path: Path, content: str, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def configure_release_signing(project_root: Path, environ: Mapping[str, str]) -> None:
    values = {}
    for name in REQUIRED_ENV:
        value = environ.get(name)
        if not isinstance(value, str) or not value:
            raise SigningConfigurationError(f"Required signing setting is missing: {name}.")
        if any(character in value for character in ("\r", "\n", "\0")):
            raise SigningConfigurationError(f"Invalid characters in signing setting: {name}.")
        values[name] = value

    root = project_root.resolve()
    keystore = Path(values["SOUL_UPLOAD_KEYSTORE_PATH"])
    if not keystore.is_absolute():
        raise SigningConfigurationError("Upload keystore path must be absolute.")
    if not keystore.is_file():
        raise SigningConfigurationError("Upload keystore file is missing.")
    if keystore.resolve().is_relative_to(root):
        raise SigningConfigurationError("Upload keystore must be stored outside the checkout.")

    build = root / "android/app/build.gradle.kts"
    properties = root / "android/key.properties"
    for path in (build, properties):
        if path.is_symlink() or not path.resolve().is_relative_to(root / "android"):
            raise SigningConfigurationError("Generated Android signing paths must stay in the checkout.")
    if not build.is_file():
        raise SigningConfigurationError("Generate Android with prepare_android.sh before signing.")

    # Validate the entire template before writing either generated file.
    source = build.read_text(encoding="utf-8")
    configured = _render_gradle(source)
    properties_content = "\n".join(
        f"{name}={_properties_value(value)}"
        for name, value in (
            ("storeFile", str(keystore)),
            ("storePassword", values["SOUL_UPLOAD_KEYSTORE_PASSWORD"]),
            ("keyAlias", values["SOUL_UPLOAD_KEY_ALIAS"]),
            ("keyPassword", values["SOUL_UPLOAD_KEY_PASSWORD"]),
        )
    ) + "\n"

    _atomic_write(properties, properties_content, 0o600)
    if configured != source:
        _atomic_write(build, configured, stat.S_IMODE(build.stat().st_mode))


def main(project_root: Path | None = None, environ: Mapping[str, str] | None = None) -> int:
    try:
        configure_release_signing(
            project_root or Path(__file__).resolve().parent.parent,
            os.environ if environ is None else environ,
        )
    except SigningConfigurationError as error:
        print(f"Release signing configuration failed: {error}", file=sys.stderr)
        return 1
    except Exception:
        # Raw filesystem/encoding errors can include credential-bearing paths.
        print("Release signing configuration failed while processing generated files.", file=sys.stderr)
        return 1
    print("Generated Android release signing configured with the external upload keystore.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
