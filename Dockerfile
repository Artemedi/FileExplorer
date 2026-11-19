FROM rust:1.88-bookworm AS dev

RUN apt-get update && apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    pkg-config \
    build-essential \
    libssl-dev \
    libglib2.0-dev \
    curl \
    wget \
    file \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add clippy rustfmt

ENV EXPLR_DATA_DIR=/tmp/explr-test-data

WORKDIR /work

FROM dev AS test

ARG INSTALL_TAURI_CLI=false
RUN if [ "$INSTALL_TAURI_CLI" = "true" ]; then cargo install tauri-cli; fi

COPY . /work
RUN mkdir -p /work/dist

CMD ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"]
