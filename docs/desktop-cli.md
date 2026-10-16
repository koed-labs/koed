# Desktop CLI launcher

Koed Desktop can install an opt-in `koed` terminal launcher on macOS and Linux.
Installation requires explicit consent; inspecting status never installs files or
changes shell configuration. Windows launcher and shell PATH management are
unsupported.

The default destination is `~/.local/bin/koed`. A custom destination selected
through Desktop is saved after successful installation and restored when Desktop
restarts. Removing the launcher keeps that selection for inspection and later
reinstallation. Saved settings identify a location, not file ownership.

Desktop recognizes only its exact launcher template for the current helper and
CLI paths. A validated semantic version in the template may differ from the
current Desktop version, so upgrading Desktop does not turn an otherwise
unchanged launcher into a conflict. Changes to executable paths or other template
content still require manual conflict resolution. Unrelated files and symlinks
are never treated as owned launchers. Removal revalidates file identity and
contents after probing the helper before unlinking.

Adding the launcher directory to shell PATH requires separate consent. Desktop
manages an exact marked block in `.zshrc` or `.bashrc`; edited blocks are preserved
and reported as conflicts. The managed PATH directory is saved independently
from the selected launcher destination. Removing a launcher, choosing another
launcher destination, or restarting Desktop does not lose the directory needed
to remove the existing PATH block. PATH removal requires separate consent and
does not remove the launcher. Open a new shell to observe PATH changes.
