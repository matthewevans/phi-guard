# This repo doubles as its own Homebrew tap:
#   brew tap matthewevans/phi-guard https://github.com/matthewevans/phi-guard.git
#   brew install nophi
class Nophi < Formula
  desc "Run Claude Code or Codex in the phi-guard NO PHI sandbox"
  homepage "https://github.com/matthewevans/phi-guard"
  url "https://github.com/matthewevans/phi-guard.git", tag: "v0.1.0"
  license :cannot_represent

  depends_on "devcontainer"

  def install
    libexec.install "bin", ".devcontainer", ".claude-plugin", ".codex-plugin", "hooks", "dist"
    bin.install_symlink libexec/"bin/nophi"
  end

  def caveats
    <<~EOS
      nophi needs Docker running. The sandbox mounts your ~/.aws read-only and its hooks
      call Bedrock with the "phi-guard" AWS profile, so add a [profile phi-guard] entry
      to ~/.aws/config whose role allows bedrock:ApplyGuardrail.

      Before the first run, export PHI_GUARD_GUARDRAIL_ID, PHI_GUARD_GUARDRAIL_VERSION
      and PHI_GUARD_AWS_REGION (PHI_GUARD_AWS_PROFILE defaults to phi-guard).
    EOS
  end

  test do
    assert_match "Usage: nophi", shell_output("#{bin}/nophi --help")
  end
end
