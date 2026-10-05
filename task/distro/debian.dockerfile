# The image task/distro.ts builds term's .deb packages and the apt index in (task/distro/debian.sh). Built once and
# cached by Docker; nothing here is published.
FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends dpkg-dev apt-utils xz-utils \
  && rm -rf /var/lib/apt/lists/*
