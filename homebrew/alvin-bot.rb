# Homebrew Formula for Alvin Bot
# Install: brew install alvbln/tap/alvin-bot
# Usage:  alvin-bot setup && alvin-bot start
# Service: brew services start alvin-bot

class AlvinBot < Formula
  desc "Personal AI agent on Telegram, WhatsApp, Discord, Signal, and Web"
  homepage "https://github.com/alvbln/alvin-bot"
  url "https://github.com/alvbln/alvin-bot/archive/refs/tags/v3.0.0.tar.gz"
  sha256 "" # Update after release
  license "MIT"

  depends_on "node@22"

  def install
    # Install production dependencies only
    system "npm", "install", "--omit=dev"

    # Build TypeScript
    system "npm", "run", "build"

    # Install everything into libexec, then symlink the CLI
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/cli.js" => "alvin-bot"

    # Ensure the CLI is executable
    chmod 0755, libexec/"bin/cli.js"
  end

  def post_install
    # Create data directories
    (var/"alvin-bot/docs/memory").mkpath
    (var/"alvin-bot/data").mkpath
  end

  def caveats
    <<~EOS
      To get started, run:
        alvin-bot setup

      To start as a background service:
        brew services start alvin-bot

      Data is stored in:
        #{var}/alvin-bot/
    EOS
  end

  service do
    run [opt_bin/"alvin-bot", "start"]
    keep_alive true
    working_dir var/"alvin-bot"
    log_path var/"log/alvin-bot.log"
    error_log_path var/"log/alvin-bot-error.log"
    environment_variables NODE_ENV: "production"
  end

  test do
    assert_match "alvin-bot", shell_output("#{bin}/alvin-bot --version 2>&1", 0)
  end
end
