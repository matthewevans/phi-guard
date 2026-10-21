# This repo doubles as its own Homebrew tap:
#   brew tap matthewevans/phi-guard https://github.com/matthewevans/phi-guard.git
#   brew install nophi
class Nophi < Formula
  desc "Run Claude Code or Codex in the phi-guard NO PHI sandbox"
  homepage "https://github.com/matthewevans/phi-guard"
  url "https://github.com/matthewevans/phi-guard.git", tag: "v0.1.0"
  license :cannot_represent

  depends_on "awscli"
  depends_on "devcontainer"
  depends_on "jq"

  def install
    libexec.install "bin", ".devcontainer", ".claude-plugin", ".codex-plugin", "hooks", "dist"
    bin.install_symlink libexec/"bin/nophi"
  end

  def caveats
    <<~EOS
      nophi needs Docker running. On every launch it mints a one-session credential on
      this machine from the AWS profile named by PHI_GUARD_AWS_PROFILE (default
      phi-guard) and mounts only that into the sandbox. Point the profile at a role
      whose only permission is ApplyGuardrailPolicy from infra/guardrail.yaml.

      Before the first run, export PHI_GUARD_GUARDRAIL_ID, PHI_GUARD_GUARDRAIL_VERSION
      and PHI_GUARD_AWS_REGION.
    EOS
  end

  test do
    assert_match "Usage: nophi", shell_output("#{bin}/nophi --help")
  end
end
