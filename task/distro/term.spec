# term's rpm, built by task/distro/fedora.sh from a release payload already unpacked in %{_sourcedir}/term.
# version, summary and node_floor are defined on the rpmbuild line. The payload is the release as built: nothing is
# compiled here, so nothing is stripped, no debug package is split off, and no dependency is guessed from its files
# (it ships its own esbuild binary, which is not a library anything else provides).
%global debug_package %{nil}
%global __os_install_post %{nil}
%global __strip /bin/true

Name:           term
Version:        %{version}
Release:        1
Summary:        %{summary}
License:        Apache-2.0
URL:            https://term.surf
AutoReqProv:    no
# the launcher runs whatever `node` is on PATH, so a Node rpm cannot see (nvm, fnm, a tarball) works too. Fedora's
# nodejs carries epoch 1, and a bare version would be read as epoch 0, which every Fedora nodejs satisfies
Recommends:     nodejs >= 1:%{node_floor}

%description
The term command: the compiler, the package manager, the test runner and the
language server of the Term language, run on Node.js %{node_floor} or newer.

%install
mkdir -p %{buildroot}/usr/lib %{buildroot}/usr/bin
cp -a %{_sourcedir}/term %{buildroot}/usr/lib/term
ln -s ../lib/term/bin/term %{buildroot}/usr/bin/term

%files
/usr/lib/term
/usr/bin/term
