# Reproducible build environment for the Android TV APK (Nuxt generate + Capacitor sync + Gradle).
# Must be linux/amd64: the Android build-tools (aapt2, zipalign) only ship x86_64 Linux binaries.
#   docker build --platform linux/amd64 -t abs-android-builder tools/android-builder
FROM --platform=linux/amd64 eclipse-temurin:21.0.5_11-jdk-jammy

ARG NODE_VERSION=20.18.1
ARG CMDLINE_TOOLS=11076708
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=/opt/node/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip xz-utils git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/node && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz | tar -xJ -C /opt/node --strip-components=1 \
    && mkdir -p $ANDROID_HOME/cmdline-tools && cd $ANDROID_HOME/cmdline-tools \
    && curl -fsSL -o t.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
    && unzip -q t.zip && mv cmdline-tools latest && rm t.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools"

WORKDIR /work
