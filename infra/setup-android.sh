#!/bin/bash
set -euo pipefail
cd /opt/verify/sandbox
rm -rf android-licenses && cp -r /opt/android/licenses android-licenses
docker build -t verify-android:base -f android.Dockerfile .
docker rm -f verify-android-prep >/dev/null 2>&1 || true
docker run -d --name verify-android-prep --device /dev/kvm --memory 6g verify-android:base sleep infinity
docker exec -d verify-android-prep sh -c 'emulator -avd verify34 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on > /tmp/emulator.log 2>&1'
docker exec verify-android-prep sh -c 'adb wait-for-device; until [ "$(adb shell getprop sys.boot_completed | tr -d "\r")" = 1 ]; do sleep 2; done'
sleep 45
docker exec verify-android-prep sh -c 'adb shell settings put global window_animation_scale 0; adb shell settings put global transition_animation_scale 0; adb shell settings put global animator_duration_scale 0; adb shell input keyevent 82; adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS'
docker exec verify-android-prep sh -c 'adb emu avd snapshot save ready && adb emu kill'
sleep 5
docker commit verify-android-prep verify-android:ready
docker rm -f verify-android-prep
echo "android image ready"
