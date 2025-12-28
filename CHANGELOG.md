# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Multi-Prompt Queuing**: Enhanced `Scheduler` with a `queuePrompt(text)` method allowing multiple distinct prompts to be queued programmatically, executing sequentially.
- **Sequential Prompt Safeguard**: Implemented a queue mechanism in `Scheduler` to ensure scheduled prompts wait for previous ones to complete before sending, preventing overlap.
- **Enhanced Dialog Options**: Added "Open Prompt Mode" and "View Dashboard" quick actions to the "Turn Off" warning and "Version 7.0" notification dialogs.
- **Background Mode Navigation**: Added "Enable Background Mode" option directly to the "Version 7.0" notification.
- **Test Infrastructure**: Added `test_dialogs_verification.js` to verify UI dialog options and `test_scheduler_safeguard.js` to verify prompt serialization.

### Verified
- **Retry Mechanism**: Verified existence of "Retry" button handling in `isAcceptButton` logic across `test_bundle.js` and `full_cdp_script.js`, ensuring agent auto-recovers from failures.

### Fixed
- **Duplicate Cancel Buttons**: Removed redundant "Cancel" buttons from the "Turn Off" warning and "Background Mode" confirmation dialogs to prevent UI confusion.

## [7.1.2] - 2025-12-28 (Since e78a8d3)

### Added
- **Extra Features (Commit 49625f1)**: Includes various improvements and feature additions prior to the current session (details inferred from commit log).
