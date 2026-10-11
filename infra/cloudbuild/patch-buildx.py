#!/usr/bin/env python3
"""Remove Buildx's sole obsolete Docker-module import without losing names."""
import hashlib
from pathlib import Path
import sys

SOURCE_SHA256='db0bf3c553a4cb87cca464e2324156993f84721e894c7f329ebb241a1c9349cb'
GO_TEST='''package store

import (
    "strings"
    "testing"
)

func TestCommerceRandomName(t *testing.T) {
    seen := make(map[string]bool)
    for range 1000 {
        name := commerceRandomName()
        if !strings.HasPrefix(name, "buildx_") || len(name) < 32 {
            t.Fatalf("invalid generated builder name: %q", name)
        }
        validated, err := ValidateName(name)
        if err != nil || validated != name || seen[name] {
            t.Fatalf("invalid or duplicate generated name: %q", name)
        }
        seen[name] = true
    }
}
'''


def patched(raw):
    if hashlib.sha256(raw).hexdigest()!=SOURCE_SHA256:
        raise RuntimeError('BUILDX_SOURCE_CHANGED')
    source=raw.decode()
    edits=(('import (\n','import (\n\t"crypto/rand"\n'),
           ('\n\t"github.com/docker/docker/pkg/namesgenerator"',''),
           ('for i := range 6 {','for range 6 {'),
           ('name = namesgenerator.GetRandomName(i)','name = commerceRandomName()'))
    for old,new in edits:
        if source.count(old)!=1:raise RuntimeError('BUILDX_GENERATOR_SHAPE_CHANGED')
        source=source.replace(old,new)
    source+='\n// commerceRandomName avoids the obsolete Docker module dependency.\n'
    source+='func commerceRandomName() string {\n\treturn "buildx_" + strings.ToLower(rand.Text())\n}\n'
    return source.encode()


def main(root):
    path=root/'store/util.go';raw=path.read_bytes()
    for candidate in root.rglob('*.go'):
        if 'vendor' not in candidate.relative_to(root).parts and candidate!=path:
            if b'"github.com/docker/docker/'in candidate.read_bytes():
                raise RuntimeError('BUILDX_ADDITIONAL_DEPRECATED_IMPORT')
    result=patched(raw)
    test=root/'store/commerce_name_test.go'
    with test.open('x')as stream:stream.write(GO_TEST)
    path.write_bytes(result)


if __name__=='__main__':main(Path(sys.argv[1]))
