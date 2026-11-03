"""Configure generated platform projects; public ads settings come from the environment."""

from pathlib import Path
import os
import plistlib
import re
import sys
import xml.etree.ElementTree as ET

from ads_configuration import (
    APP_ID_METADATA, DELAY_MEASUREMENT_METADATA, MODE_METADATA, UNIT_ID_METADATA,
    AdsConfigurationError, resolve_ads,
)


ANDROID_URI = 'http://schemas.android.com/apk/res/android'
ANDROID = '{' + ANDROID_URI + '}'
ET.register_namespace('android', ANDROID_URI)
ET.register_namespace('tools', 'http://schemas.android.com/tools')


def configure_android_manifest(xml: str, environ) -> str:
    ads = resolve_ads(environ)
    if '<!DOCTYPE' in xml.upper():
        raise ValueError('Android manifest document types are not permitted.')
    try:
        manifest = ET.fromstring(xml, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
    except ET.ParseError:
        raise ValueError('Android manifest is not valid XML.') from None
    applications = manifest.findall('application')
    if manifest.tag != 'manifest' or len(applications) != 1:
        raise ValueError('Android manifest must contain exactly one application.')
    application = applications[0]
    if application.get(ANDROID + 'label') == 'soul_reader':
        application.set(ANDROID + 'label', 'SOUL READER')
    if not any(item.get(ANDROID + 'name') == 'android.permission.INTERNET'
               and item.get(ANDROID + 'maxSdkVersion') is None
               for item in manifest.findall('uses-permission')):
        manifest.insert(0, ET.Element('uses-permission', {ANDROID + 'name': 'android.permission.INTERNET'}))
    # Defer automatic app measurement until explicit SDK initialization after UMP.
    # This setting does not establish that native providers make no network calls.
    for name, value in ((APP_ID_METADATA, ads.app_id), (DELAY_MEASUREMENT_METADATA, 'true'),
                        (MODE_METADATA, ads.mode),
                        (UNIT_ID_METADATA, ads.interstitial_id)):
        existing = [item for item in application.findall('meta-data')
                    if item.get(ANDROID + 'name') == name]
        element = existing[0] if existing else ET.SubElement(application, 'meta-data')
        element.attrib.clear()
        element.set(ANDROID + 'name', name)
        element.set(ANDROID + 'value', value)
        for duplicate in existing[1:]:
            application.remove(duplicate)
    ET.indent(manifest, space='    ')
    return ET.tostring(manifest, encoding='unicode') + '\n'


def configure(root: Path, environ) -> None:
    # Validate before modifying any generated files, including Gradle and iOS.
    resolve_ads(environ)
    manifest = root / 'android/app/src/main/AndroidManifest.xml'
    configured_manifest = (configure_android_manifest(manifest.read_text(), environ)
                           if manifest.exists() else None)
    build = root / 'android/app/build.gradle.kts'
    if build.exists():
        source = build.read_text()
        source = re.sub(r'(?m)^(\s*)minSdk\s*=\s*flutter\.minSdkVersion', r'\1minSdk = 24', source)
        source = re.sub(r'(?m)^(\s*)compileSdk\s*=\s*flutter\.compileSdkVersion', r'\1compileSdk = 36', source)
        build.write_text(source)
    if configured_manifest is not None:
        manifest.write_text(configured_manifest)
    xml = root / 'ios/Runner/Info.plist'
    if xml.exists():
        with xml.open('rb') as source:
            data = plistlib.load(source)
        data['NSCameraUsageDescription'] = '셀카 촬영과 기기 내 얼굴 윤곽 분석에 카메라를 사용합니다.'
        data['NSPhotoLibraryUsageDescription'] = '선택한 사진의 얼굴 윤곽을 기기 내에서 분석하는 데 사용합니다.'
        with xml.open('wb') as output:
            plistlib.dump(data, output)
    pod = root / 'ios/Podfile'
    if pod.exists():
        source = pod.read_text()
        source = re.sub(r"(?m)^#?\s*platform :ios, '[^']+'", "platform :ios, '15.5'", source)
        if "platform :ios, '15.5'" not in source:
            source = "platform :ios, '15.5'\n" + source
        pod.write_text(source)


def main() -> int:
    try:
        configure(Path(__file__).resolve().parent.parent, os.environ)
    except (AdsConfigurationError, ValueError) as error:
        print('Platform configuration failed: ' + str(error), file=sys.stderr)
        return 1
    print('Android minSdk 24 / compileSdk 36, AdMob settings and iOS target 15.5 configured when available.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
