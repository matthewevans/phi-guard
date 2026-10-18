# This repo doubles as its own Homebrew tap:
#   brew tap REPLACE_ORG/phi-guard git@github.com:REPLACE_ORG/phi-guard.git
#   brew install nophi
class Nophi < Formula
  desc "Run Claude Code or Codex in the phi-guard NO PHI sandbox"
  homepage "https://github.com/REPLACE_ORG/phi-guard"
  url "git@github.com:REPLACE_ORG/phi-guard.git", tag: "v0.1.0", using: :git
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
    EOS
  end

  test do
    assert_match "Usage: nophi", shell_output("#{bin}/nophi --help")
  end
end
