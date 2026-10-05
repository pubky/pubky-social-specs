#!/bin/sh
# Full replica keys for the prefixes given, one per line; the keys are in the replica's directory names.
for p in "$@"; do ls "${QA_DATA:-data}/replica" | grep "^$p"; done
