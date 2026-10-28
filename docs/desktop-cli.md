# Desktop CLI launcher

Koed Desktop can install an opt-in `koed` terminal launcher on macOS and Linux.
Installation requires explicit consent; inspecting status never installs files or
changes shell configuration. Windows launcher and shell PATH management are
unsupported.

The default destination is `~/.local/bin/koed`. A custom destination selected
through Desktop is saved after successful installation and restored when Desktop
restarts. Removing the launcher keeps that selection for inspection and later
reinstallation. Saved settings identify a location, not file ownership.

The launcher runs Desktop's verified packaged CLI entrypoint and binds
`KOED_HOME` to Desktop's own instance, so `koed status`, `doctor`, `setup`,
client repair, `start`, `stop`, and `restart` manage that same instance whether
Desktop is open or closed. `koed start --daemon` leaves a detached supervisor
that Desktop reconnects to when it opens, without starting a second one. An
independently installed npm CLI keeps its own instance and cannot manage
Desktop's. Packaged `stop` and `restart` require a matching owner pin and
supervisor process identity; missing or foreign proof fails closed without
signaling the runtime or clearing its state. Set `KOED_HOME` to use a different
instance only with a standalone installation: the Desktop launcher always
selects Desktop's state directory. Desktop's persisted generation owner also
remains in force while its supervisor is stopped, so a standalone `start` cannot
claim that `KOED_HOME` just because no process is running.

Desktop recognizes only its exact launcher template for the current helper,
CLI entrypoint, and `KOED_HOME`. An unchanged launcher from an earlier Desktop
that targets the generic CLI is recognized as an upgradeable legacy launcher and
replaced only through the explicit install action; an edited launcher is never
overwritten. Moving the Desktop app changes the launcher paths and requires
explicit reinstallation, not silent reassignment. A validated semantic version in the template may differ from the
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
