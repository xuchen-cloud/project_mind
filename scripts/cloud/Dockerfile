# syntax=docker/dockerfile:1
# Development/test environment only; not an application distribution image.
FROM public.ecr.aws/docker/library/rust:1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e
RUN --mount=type=secret,id=proxy_ca,required=true \
    apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libasound2-dev patchelf cmake clang lld protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/project_mind
RUN --mount=type=secret,id=proxy_ca,required=true \
    SSL_CERT_FILE=/run/secrets/proxy_ca rustup component add rustfmt
ENV CARGO_TARGET_DIR=/workspace/project-mind-env/target
ENV CARGO_BUILD_JOBS=2
ENV CARGO_PROFILE_DEV_DEBUG=0
ENV CARGO_PROFILE_TEST_DEBUG=0
ENV SHERPA_ONNX_ARCHIVE_DIR=/workspace/project-mind-env/native-archives
