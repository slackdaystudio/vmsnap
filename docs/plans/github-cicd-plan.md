# GitHub CI/CD Infrastructure Plan for VMSnap

## Overview

This document outlines a comprehensive CI/CD strategy for VMSnap using GitHub Actions. The plan addresses the unique challenges of testing a KVM virtualization tool while ensuring robust automation for testing, building, and deployment.

## Current State Analysis

### Existing Infrastructure
- **Repository**: `git@github.com:slackdaystudio/vmsnap.git`
- **Package Registry**: GitHub Packages (`@sentry0:registry`)
- **Current Workflow**: Basic release publishing to npm
- **Issue Template**: Bug report template requiring system dependencies

### Limitations of Current Setup
- No automated testing on pull requests
- No multi-environment testing
- Missing dependency validation
- No security scanning
- Limited release automation

## CI/CD Pipeline Architecture

### Pipeline Overview
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Pull Request  │───▶│  Continuous      │───▶│  Continuous     │
│   Validation    │    │  Integration     │    │  Deployment     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ • Lint & Format │    │ • Unit Tests     │    │ • GitHub Packages│
│ • Dependency    │    │ • Integration    │    │ • npm Registry   │
│ • Security Scan │    │ • Multi-platform │    │ • Documentation │
│ • Build Check   │    │ • Performance    │    │ • Release Notes │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Workflow Definitions

### 1. Pull Request Validation (`pr-validation.yml`)

**Triggers**: Pull request opened, updated, synchronized
**Purpose**: Fast feedback on code quality and basic functionality

```yaml
name: Pull Request Validation

on:
  pull_request:
    branches: [dev, main]
  pull_request_target:
    types: [opened, synchronize, reopened]

jobs:
  validate-pr:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Lint code
        run: npm run lint
        
      - name: Check formatting
        run: npm run check-format
        
      - name: Build project
        run: npm run build
        
      - name: Validate package.json
        run: npm run validate-package
        
      - name: Security audit
        run: npm audit --audit-level=moderate
        
  dependency-review:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Dependency Review
        uses: actions/dependency-review-action@v3
        with:
          fail-on-severity: moderate
```

### 2. Continuous Integration (`ci.yml`)

**Triggers**: Push to dev/main, pull request merge
**Purpose**: Comprehensive testing across multiple environments

```yaml
name: Continuous Integration

on:
  push:
    branches: [dev, main]
  pull_request:
    branches: [dev, main]
  schedule:
    - cron: '0 2 * * 1' # Weekly on Monday

env:
  NODE_VERSION_FILE: '.nvmrc'

jobs:
  unit-tests:
    name: Unit Tests (Node ${{ matrix.node }})
    runs-on: ubuntu-latest
    timeout-minutes: 15
    
    strategy:
      matrix:
        node: [18, 20, 22]
        
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Setup Node.js ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run unit tests
        run: npm run test:unit
        
      - name: Generate coverage report
        run: npm run test:coverage
        
      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage/lcov.info
          flags: unittests
          name: node-${{ matrix.node }}

  integration-tests:
    name: Integration Tests (KVM)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
          sudo usermod -a -G kvm $USER
          
      - name: Install virtualization dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            qemu-kvm \
            qemu-utils \
            libvirt-daemon-system \
            libvirt-clients \
            virtinst \
            python3-pip
          sudo systemctl start libvirtd
          sudo systemctl enable libvirtd
          sudo usermod -a -G libvirt $USER
          
      - name: Install virtnbdbackup
        run: |
          pip3 install virtnbdbackup
          echo "$HOME/.local/bin" >> $GITHUB_PATH
          
      - name: Verify dependencies
        run: |
          virsh version
          qemu-img --version
          virtnbdbackup --version
          
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: ${{ env.NODE_VERSION_FILE }}
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Setup test environment
        run: |
          sudo mkdir -p /tmp/vmsnap-test
          sudo chown $USER:$USER /tmp/vmsnap-test
          
      - name: Run integration tests
        run: |
          newgrp libvirt << EOF
          npm run test:integration
          EOF
          
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: integration-test-results
          path: |
            test-results/
            /tmp/vmsnap-test/logs/

  security-scan:
    name: Security Scanning
    runs-on: ubuntu-latest
    timeout-minutes: 10
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          format: 'sarif'
          output: 'trivy-results.sarif'
          
      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v2
        if: always()
        with:
          sarif_file: 'trivy-results.sarif'
          
      - name: NPM Security Audit
        run: |
          npm audit --audit-level=high --production
          
  build-and-package:
    name: Build and Package
    runs-on: ubuntu-latest
    needs: [unit-tests, security-scan]
    timeout-minutes: 10
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: ${{ env.NODE_VERSION_FILE }}
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build project
        run: npm run build
        
      - name: Package for testing
        run: npm pack
        
      - name: Upload build artifacts
        uses: actions/upload-artifact@v3
        with:
          name: build-artifacts
          path: |
            dist/
            *.tgz
            
  compatibility-test:
    name: Compatibility Test (OS ${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    needs: build-and-package
    timeout-minutes: 20
    
    strategy:
      matrix:
        os: [ubuntu-20.04, ubuntu-22.04, ubuntu-24.04]
        
    steps:
      - name: Download build artifacts
        uses: actions/download-artifact@v3
        with:
          name: build-artifacts
          
      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y qemu-utils libvirt-clients
          
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          
      - name: Test package installation
        run: |
          npm install -g vmsnap-*.tgz
          vmsnap --help
```

### 3. Performance Testing (`performance.yml`)

**Triggers**: Push to main, scheduled weekly
**Purpose**: Monitor performance regressions and resource usage

```yaml
name: Performance Testing

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 3 * * 0' # Weekly on Sunday

jobs:
  performance-benchmark:
    name: Performance Benchmarks
    runs-on: ubuntu-latest
    timeout-minutes: 45
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Full history for comparisons
          
      - name: Setup test environment
        uses: ./.github/actions/setup-kvm
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run performance tests
        run: npm run test:performance
        
      - name: Store benchmark result
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'customSmallerIsBetter'
          output-file-path: performance-results.json
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auto-push: true
          
      - name: Performance regression check
        run: |
          # Compare with previous benchmarks
          npm run compare-performance
```

### 4. Release Management (`release.yml`)

**Triggers**: GitHub release created, manual workflow dispatch
**Purpose**: Automated versioning, building, and publishing

```yaml
name: Release Management

on:
  release:
    types: [created, published]
  workflow_dispatch:
    inputs:
      release_type:
        description: 'Release type'
        required: true
        default: 'patch'
        type: choice
        options:
          - patch
          - minor
          - major
      prerelease:
        description: 'Pre-release'
        required: false
        default: false
        type: boolean

env:
  REGISTRY_URL: https://npm.pkg.github.com

jobs:
  prepare-release:
    name: Prepare Release
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'
    
    outputs:
      new_version: ${{ steps.version.outputs.new_version }}
      
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
          
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          
      - name: Configure Git
        run: |
          git config --global user.name 'github-actions[bot]'
          git config --global user.email 'github-actions[bot]@users.noreply.github.com'
          
      - name: Bump version
        id: version
        run: |
          npm version ${{ inputs.release_type }} --no-git-tag-version
          NEW_VERSION=$(node -p "require('./package.json').version")
          echo "new_version=$NEW_VERSION" >> $GITHUB_OUTPUT
          
      - name: Update CHANGELOG
        run: |
          npm run generate-changelog
          
      - name: Commit changes
        run: |
          git add package.json package-lock.json CHANGELOG.md
          git commit -m "chore: bump version to v${{ steps.version.outputs.new_version }}"
          git tag -a "v${{ steps.version.outputs.new_version }}" -m "Release v${{ steps.version.outputs.new_version }}"
          
      - name: Push changes
        run: |
          git push origin dev
          git push origin "v${{ steps.version.outputs.new_version }}"

  build-and-test:
    name: Build and Test Release
    runs-on: ubuntu-latest
    needs: [prepare-release]
    if: always() && !cancelled()
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name || format('v{0}', needs.prepare-release.outputs.new_version) }}
          
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run full test suite
        run: |
          npm run test:unit
          npm run lint
          npm run check-format
          
      - name: Build for release
        run: npm run build
        
      - name: Package verification
        run: |
          npm pack --dry-run
          
  publish-github:
    name: Publish to GitHub Packages
    runs-on: ubuntu-latest
    needs: [build-and-test]
    permissions:
      contents: read
      packages: write
      
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: ${{ env.REGISTRY_URL }}
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build project
        run: npm run build
        
      - name: Publish to GitHub Packages
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          
  publish-npm:
    name: Publish to NPM Registry
    runs-on: ubuntu-latest
    needs: [build-and-test, publish-github]
    if: github.event.release.prerelease == false
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build project
        run: npm run build
        
      - name: Publish to NPM
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          
  update-documentation:
    name: Update Documentation
    runs-on: ubuntu-latest
    needs: [publish-npm]
    if: always() && needs.build-and-test.result == 'success'
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
          
      - name: Generate API documentation
        run: |
          npm run generate-docs
          
      - name: Update GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./docs/generated
```

## Custom Actions and Reusable Components

### Setup KVM Action (`.github/actions/setup-kvm/action.yml`)

```yaml
name: 'Setup KVM Environment'
description: 'Configure KVM virtualization for testing'

runs:
  using: 'composite'
  steps:
    - name: Enable KVM
      shell: bash
      run: |
        echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
        sudo udevadm control --reload-rules
        sudo udevadm trigger --name-match=kvm
        
    - name: Install virtualization stack
      shell: bash
      run: |
        sudo apt-get update
        sudo apt-get install -y \
          qemu-kvm \
          qemu-utils \
          libvirt-daemon-system \
          libvirt-clients \
          python3-pip
        sudo systemctl start libvirtd
        sudo usermod -a -G kvm,libvirt $USER
        
    - name: Install virtnbdbackup
      shell: bash
      run: |
        pip3 install virtnbdbackup
        echo "$HOME/.local/bin" >> $GITHUB_PATH
```

## Environment Configuration

### Node Version Management (`.nvmrc`)
```
20
```

### Environment Variables and Secrets

**Required Secrets:**
- `NPM_TOKEN`: NPM registry authentication
- `RELEASE_TOKEN`: GitHub token with write access for releases
- `CODECOV_TOKEN`: Code coverage service integration

**Environment Variables:**
```yaml
env:
  NODE_ENV: test
  CI: true
  DEBIAN_FRONTEND: noninteractive
```

## Quality Gates and Policies

### Branch Protection Rules

**Main Branch:**
- Require pull request reviews (2 reviewers)
- Require status checks to pass:
  - Unit Tests (all Node versions)
  - Integration Tests
  - Security Scan
  - Lint and Format
- Require branches to be up to date
- Require signed commits
- Restrict pushes to administrators only

**Dev Branch:**
- Require pull request reviews (1 reviewer)
- Require status checks to pass:
  - Unit Tests (Node 20 only)
  - Lint and Format
- Allow force pushes for maintainers

### Code Coverage Requirements
- **Minimum overall coverage**: 85%
- **Minimum new code coverage**: 90%
- **Coverage decrease threshold**: -2%

### Security Policies
- Automatic dependency updates via Dependabot
- Security vulnerability scanning on all PRs
- SARIF report integration with GitHub Security
- NPM audit threshold: High severity

## Monitoring and Observability

### Performance Monitoring
- Benchmark tracking for backup operations
- Resource usage monitoring during CI runs
- Test execution time trending

### Metrics Collection
```yaml
# Collect CI/CD metrics
- name: Collect metrics
  run: |
    echo "test_duration=${{ steps.test.outputs.duration }}" >> $GITHUB_ENV
    echo "coverage_percentage=${{ steps.coverage.outputs.percentage }}" >> $GITHUB_ENV
```

### Notification Strategy
- **Slack Integration**: Build status notifications
- **Email Alerts**: Failed releases, security issues
- **GitHub Issues**: Automatic creation for failed scheduled runs

## Deployment Strategies

### Deployment Environments
1. **Development**: Automatic deployment from dev branch
2. **Staging**: Manual deployment for pre-release testing
3. **Production**: Automatic deployment on release

### Blue-Green Deployment
For package registry publishing:
- Publish to GitHub Packages first (canary)
- Run additional verification
- Publish to NPM registry (production)

### Rollback Procedures
- Automated rollback triggers for failed deployments
- Manual rollback procedures documented
- Version deprecation in npm registry

## Cost Optimization

### Resource Management
- Parallel job limits to control costs
- Timeout configurations for all jobs
- Conditional execution based on file changes

### Caching Strategy
```yaml
- name: Cache dependencies
  uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

## Migration Plan

### Phase 1: Foundation (Week 1-2)
- [ ] Implement basic CI workflow
- [ ] Setup unit testing infrastructure
- [ ] Configure branch protection rules
- [ ] Setup NPM publishing

### Phase 2: Testing (Week 3-4)
- [ ] Implement integration testing with KVM
- [ ] Add security scanning
- [ ] Setup performance benchmarking
- [ ] Configure code coverage reporting

### Phase 3: Advanced Features (Week 5-6)
- [ ] Implement automated releases
- [ ] Setup documentation generation
- [ ] Add multi-platform compatibility testing
- [ ] Configure monitoring and alerting

### Phase 4: Optimization (Week 7-8)
- [ ] Optimize CI execution times
- [ ] Implement advanced caching
- [ ] Fine-tune quality gates
- [ ] Performance analysis and improvements

## Success Metrics

### Reliability Targets
- **CI success rate**: >95%
- **Test flake rate**: <2%
- **Build time**: <15 minutes total
- **Integration test time**: <30 minutes

### Quality Metrics
- **Code coverage**: >85%
- **Security vulnerability**: 0 high/critical
- **Documentation coverage**: >90%
- **Performance regression**: 0%

### Developer Experience
- **PR feedback time**: <10 minutes
- **Release cycle time**: <2 hours
- **Failed build notification**: <5 minutes
- **Developer onboarding**: <1 day