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

In Preferences → General → Optional tools, Command line automatically inspects
its launcher. **Install command line** installs the launcher and adds its
directory to PATH in one explicit action. The dialog explains the shell startup
file change before installation. Desktop manages an exact marked block in
`.zshrc` for zsh. For Bash it manages the block in `.bashrc` and in the login
startup file that Bash reads: the first of `.bash_profile`, `.bash_login`, and
`.profile` that exists, or a new `.bash_profile` when none exists. Login shells,
such as the macOS Terminal default, do not read `.bashrc` on their own. Setup
reports the command line as ready only after inspection finds the block in
every required file. Edited blocks are preserved and reported as conflicts.
The saved managed directory remains independent from the launcher destination.

Setup shows launcher installation and PATH setup as separate progress steps.
If PATH setup fails after installation, the dialog reports that the launcher
exists and provides a retry. **Remove command line** removes the managed PATH
entry before removing the unchanged Koed-owned launcher. Partial failures are
reported with the underlying error. Open a new terminal after successful setup.

Privacy Filter installation from Preferences requires a packaged Koed app with
its verified Desktop supervisor. Source/development builds report this feature
as unavailable without attempting to start an asset-management supervisor.

Privacy Filter is an optional local component used to help remove personally
identifiable information before memory is shared with a Team. **Download and
install** authorizes its download and any local service restart. The dialog
shows download, verification, and activation progress, and provides retry after
failure. Closing a setup dialog lets installation continue; download and
verification can be cancelled before activation begins. The Preferences UI does
not offer an offline file picker. Component manifest pins, archive validation,
and activation checks still apply.

The verified Desktop launcher uses the same command dispatcher as the standalone CLI.
Public help at every command level therefore uses the same command definitions.
Installation verification still precedes dispatch, including help requests.
