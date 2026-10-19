from pathlib import Path
import re, plistlib
root=Path(__file__).resolve().parent.parent
build=root/'android/app/build.gradle.kts'
if build.exists():
 s=build.read_text()
 s=re.sub(r'(?m)^(\s*)minSdk\s*=\s*flutter\.minSdkVersion',r'\1minSdk = 24',s)
 s=re.sub(r'(?m)^(\s*)compileSdk\s*=\s*flutter\.compileSdkVersion',r'\1compileSdk = 36',s)
 build.write_text(s)
manifest=root/'android/app/src/main/AndroidManifest.xml'
if manifest.exists():
 s=manifest.read_text()
 s=s.replace('android:label="soul_reader"', 'android:label="SOUL READER"')
 permission='<uses-permission android:name="android.permission.INTERNET" />'
 if permission not in s:
  s=s.replace('<application', permission+'\n    <application', 1)
 manifest.write_text(s)
xml=root/'ios/Runner/Info.plist' 
if xml.exists():
 with xml.open('rb') as f: data=plistlib.load(f)
 data['NSCameraUsageDescription']='셀카 촬영과 기기 내 얼굴 윤곽 분석에 카메라를 사용합니다.'
 data['NSPhotoLibraryUsageDescription']='선택한 사진의 얼굴 윤곽을 기기 내에서 분석하는 데 사용합니다.'
 with xml.open('wb') as f:plistlib.dump(data,f)
pod=root/'ios/Podfile'
if pod.exists():
 s=pod.read_text()
 s=re.sub(r"(?m)^#?\s*platform :ios, '[^']+'", "platform :ios, '15.5'", s)
 if "platform :ios, '15.5'" not in s: s="platform :ios, '15.5'\n"+s
 pod.write_text(s)
print('Android minSdk 24 / compileSdk 36, iOS deployment target 15.5 configured when available.')
