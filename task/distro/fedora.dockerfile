# The image task/distro.ts builds term's .rpm packages and the dnf index in (task/distro/fedora.sh). Built once and
# cached by Docker; nothing here is published.
FROM fedora:42
RUN dnf install -y rpm-build createrepo_c \
  && dnf clean all
