# jay — development install, packaging, and marketplace publish
#
# Publishing needs a one-time setup, the same as perch's:
#   1. The publisher at https://marketplace.visualstudio.com/manage (it must match "publisher" in package.json)
#   2. An Azure DevOps PAT (org: All accessible, scope: Marketplace > Manage)
#   3. Either 'make login' once, the token in ~/.ssh/azure-dev.pat, or VSCE_PAT=<token> in .env
#
-include .env
PAT_FILE = $(HOME)/.ssh/azure-dev.pat
ifeq ($(VSCE_PAT),)
VSCE_PAT = $(shell [ -r $(PAT_FILE) ] && tr -d '\n' < $(PAT_FILE))
endif
export VSCE_PAT

VSCE = npx --yes @vscode/vsce
VERSION = $(shell node -p "require('./package.json').version")
PUBLISHER = $(shell node -p "require('./package.json').publisher")
VSIX = jay-$(VERSION).vsix
EXT_ID = seanahn.jay-$(VERSION)
EXT_DIRS = $(HOME)/.vscode/extensions $(HOME)/.local/share/code-server/extensions $(HOME)/.vscode-server/extensions

## Install the development dependencies (jsdom, for the page tests)
deps:
	npm install --silent

## Syntax-check the sources
check:
	npm run -s check

## Every test: no network, no real token file
test: deps
	npm run -s test

## Symlink this checkout into every VS Code / code-server extension dir
install: deps check
	@for d in $(EXT_DIRS); do rm -f $$d/seanahn.jay-*; [ -d $$d ] && ln -sfn $(CURDIR) $$d/$(EXT_ID) && echo "linked $$d/$(EXT_ID)"; done; true
	@echo "jay installed. Reload the window to activate."

## Rebuild the committed ProseMirror bundle (media/prosemirror.js); not part of install or package
vendor:
	npx esbuild vendor/entry.js --bundle --format=iife --global-name=PM --minify --banner:js="/*! ProseMirror bundling prosemirror-model, prosemirror-state, prosemirror-view, prosemirror-transform, prosemirror-keymap, prosemirror-commands, prosemirror-history, prosemirror-inputrules, prosemirror-schema-list, prosemirror-dropcursor, prosemirror-gapcursor, orderedmap, rope-sequence, w3c-keyname. MIT License. Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others. Full texts: THIRD_PARTY_LICENSES.md */" --outfile=media/prosemirror.js

## Remove the symlinks
uninstall:
	@for d in $(EXT_DIRS); do rm -f $$d/seanahn.jay-*; done; echo "jay unlinked"

## Build a .vsix
package: deps check
	$(VSCE) package

## Install the packaged .vsix in place of the development symlink
install-vsix: package uninstall
	@command -v code-server >/dev/null 2>&1 && code-server --install-extension $(VSIX) --force \
		|| code --install-extension $(VSIX) --force

## One-time: store the marketplace PAT for the publisher
login:
	$(VSCE) login $(PUBLISHER)

## Publish the version in package.json to the marketplace
publish: deps check
	$(VSCE) publish

clean:
	rm -f *.vsix

.PHONY: deps check test vendor install uninstall package install-vsix login publish clean
