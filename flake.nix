{
  description = "scheduling-bridge development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        python = pkgs.python312.override {
          packageOverrides = final: prev: {
            backrefs = prev.backrefs.overridePythonAttrs (_: {
              doCheck = false;
            });
          };
        };
        bazel = pkgs.writeShellScriptBin "bazel" ''
          exec ${pkgs.bazelisk}/bin/bazelisk "$@"
        '';
        docsPython = python.withPackages (
          ps: with ps; [
            mkdocs
            mkdocs-material
            pymdown-extensions
          ]
        );
      in
      {
        formatter = pkgs.nixfmt-rfc-style;

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bazel
            bazelisk
            direnv
            docsPython
            git
            jdk21_headless
            nodejs_24
            pnpm
            playwright-driver.browsers
            ripgrep
            tectonic
          ];

          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            echo "scheduling-bridge dev shell"
            echo "  node      $(node --version)"
            echo "  pnpm      $(pnpm --version)"
            echo "  bazel     $(bazel --version | head -n1)"
            echo "  mkdocs    $(mkdocs --version | awk '{print $3}')"
          '';
        };
      }
    );
}
