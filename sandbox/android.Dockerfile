FROM verify-base:latest
ENV ANDROID_HOME=/opt/android ANDROID_SDK_ROOT=/opt/android
ENV PATH=$PATH:/opt/android/cmdline-tools/latest/bin:/opt/android/platform-tools:/opt/android/emulator:/root/.maestro/bin
ENV MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip libpulse0 libgl1 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 libxdamage1 libxrandr2 && rm -rf /var/lib/apt/lists/*
COPY android-licenses/ /opt/android/licenses/
RUN mkdir -p /opt/android/cmdline-tools && cd /opt/android \
  && curl -sSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
  && unzip -q tools.zip -d cmdline-tools && mv cmdline-tools/cmdline-tools cmdline-tools/latest && rm tools.zip
RUN sdkmanager --install "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64" < /dev/null > /dev/null
RUN echo no | avdmanager create avd -n verify34 -k "system-images;android-34;google_apis;x86_64" -d pixel_6 \
  && printf 'hw.ramSize=3072\ndisk.dataPartition.size=4G\nhw.keyboard=yes\n' >> /root/.android/avd/verify34.avd/config.ini
RUN curl -Ls "https://get.maestro.mobile.dev" | bash
COPY android-runner.mjs /opt/verify/
