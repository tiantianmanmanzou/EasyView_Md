# EasyView_Md Windows Smoke Test

This is a sample markdown file used for testing the Windows build.

## Features

### Headings Work
As you can see from the headings above.

### Tables Work

| Feature | Status | Notes |
|---------|--------|-------|
| Markdown rendering | ✓ | Core functionality |
| File opening | ✓ | Via CLI argument |
| Window creation | ✓ | Electron window |

### Code Blocks Work

```javascript
function testEasyViewMd() {
  console.log("Testing EasyView_Md on Windows");
  return true;
}
```

```python
def test_markdown():
    print("Python code block test")
    return "success"
```

### Lists Work

- First item
- Second item
  - Nested item
  - Another nested item
- Third item

1. Numbered first
2. Numbered second
3. Numbered third

## Conclusion

If you can see this properly formatted, the Windows build is working correctly!
