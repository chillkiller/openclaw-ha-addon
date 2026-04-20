# Contributing to OpenClaw Home Assistant Addon

Thank you for your interest in contributing to the OpenClaw Home Assistant Addon! This document provides guidelines and instructions for contributing.

## Code of Conduct

This project adheres to a Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to [GitHub Issues](https://github.com/chillkiller/openclaw-ha-addon/issues).

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check the existing issues as you might find that the problem has already been reported. When creating a bug report, please include:

- A clear and descriptive title
- Steps to reproduce the problem
- Expected behavior
- Actual behavior
- Screenshots or logs if applicable
- Your Home Assistant version
- Add-on version
- Any relevant configuration

### Suggesting Enhancements

Enhancement suggestions are tracked as [GitHub Issues](https://github.com/chillkiller/openclaw-ha-addon/issues). When creating an enhancement suggestion, please:

- Use a clear and descriptive title
- Provide a detailed description of the suggested enhancement
- Explain why this enhancement would be useful
- List some examples of how this feature would be used

### Pull Requests

1. **Fork the repository** and create your branch from `main`.
2. **Make your changes** following the existing code style and structure.
3. **Test your changes** thoroughly in a development environment.
4. **Update documentation** if your changes affect user-facing behavior.
5. **Commit your changes** with clear, descriptive commit messages.
6. **Push to your fork** and submit a pull request.

#### Pull Request Guidelines

- Keep PRs focused and atomic
- Include tests for new features when applicable
- Update the CHANGELOG if your change affects users
- Ensure all CI checks pass before requesting review
- Respond to review feedback promptly

## Development Setup

### Prerequisites

- Docker
- Home Assistant development environment or Home Assistant OS
- Git

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/chillkiller/openclaw-ha-addon.git
   cd openclaw-ha-addon
   ```

2. Build the add-on locally:
   ```bash
   docker build -t openclaw-ha-addon .
   ```

3. Test the add-on in your Home Assistant instance.

### Testing

Before submitting a PR, ensure:

- The add-on builds successfully
- The add-on starts without errors
- New features work as expected
- Existing features are not broken
- Configuration options are properly validated

## Coding Standards

- Follow the existing code style and structure
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and small
- Avoid unnecessary complexity

## Documentation

- Update README.md for user-facing changes
- Update inline code comments for technical changes
- Add examples for new features
- Keep documentation in sync with code changes

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

## Questions?

Feel free to open an issue for questions or discussion about contributions.