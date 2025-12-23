# Legal Compliance - Fork of Obsidian Clipper

## Summary

This repository is a fork of the [obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper) project, which is licensed under the MIT License. This document summarizes the legal compliance status.

## ✅ Corrections Made

### 1. **package.json**
- ✅ Changed name from `obsidian-clipper` to `ecom-scraper`
- ✅ Updated description to reflect the actual purpose of the project
- ❌ **Pending**: Update `package-lock.json` by running `npm install`

### 2. **LICENSE**
- ✅ Maintained MIT license (required)
- ✅ Preserved original Obsidian copyright
- ✅ Added fork copyright
- ✅ Added attribution note to original project

### 3. **README.md**
- ✅ Mentioned derivation from original project
- ✅ Added direct link to original repository
- ✅ Added attribution section with copyright

### 4. **Issue Templates**
- ✅ Removed references to Obsidian in GitHub templates
- ✅ Updated bug report template

## ⚠️ Additional Considerations

### Xcode Files (Safari Extension)
Files in `xcode/` contain:
- Bundle identifiers: `md.obsidian.Obsidian-Web-Clipper`
- Application names: "Obsidian Web Clipper"
- References in Swift code

**Recommendation**: 
- If you **DO NOT** plan to distribute the Safari extension publicly, these files can remain as-is (they're only for local development)
- If you **DO** plan to distribute it, you should:
  1. Change bundle identifiers to your own (e.g., `com.yourdomain.ecom-scraper`)
  2. Update application names
  3. Update references in Swift code

### Documentation in `docs/`
Files in `docs/` appear to be from the original project. If you keep them:
- ✅ They're fine if you preserve the original content
- ⚠️ Consider adding a note indicating they are derived from the original project

## 📋 MIT License Legal Requirements

### ✅ Complied:
1. ✅ Maintain original copyright notice
2. ✅ Maintain permission notice (complete MIT license)
3. ✅ Include LICENSE file
4. ✅ Add your own copyright for modifications

### 📝 Recommended Next Steps:

1. **Update package-lock.json**:
   ```bash
   npm install
   ```

2. **If distributing Safari extension**: Update Xcode files with new bundle identifiers

3. **Consider adding a NOTICE file** (optional but recommended):
   ```
   This project includes code from obsidianmd/obsidian-clipper
   Copyright (c) 2024 Obsidian Publish Ltd. and contributors
   Licensed under MIT License
   ```

## ⚖️ Current Legal Status

**Status**: ✅ **COMPLIES WITH BASIC LEGAL REQUIREMENTS**

The repository meets the minimum requirements of the MIT license:
- Maintains original copyright
- Maintains MIT license
- Includes attribution to original project
- Adds copyright for modifications

**Note**: Xcode files are only problematic if you plan to distribute the Safari extension publicly. For internal/development use they're fine.

## References

- [MIT License](https://opensource.org/licenses/MIT)
- [Original Project](https://github.com/obsidianmd/obsidian-clipper)
- [MIT Forking Guide](https://qastack.mx/software/277688/if-i-fork-a-project-on-github-that-is-licensed-under-mit-how-to-i-handle-the-at)
