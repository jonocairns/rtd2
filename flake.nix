{
  description = "media-agent — REPL toolkit agent for self-hosted media";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system}; in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            pnpm
          ];

          shellHook = ''
            echo "media-agent dev shell"
            echo "  node $(node --version)"
            echo "  pnpm $(pnpm --version)"
          '';
        };
      });
}
