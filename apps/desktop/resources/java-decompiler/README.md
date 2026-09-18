# Fernflower Java decompiler runtime

`java-decompiler.jar` provides JetBrains Fernflower's `ConsoleDecompiler` entry point and is invoked only for an explicit `.class` preview request. EasyView does not bundle a JRE; the host reports a dependency error when `java` is unavailable.

Runtime command:

```text
java -cp java-decompiler.jar org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler <class> <output-directory>
```

The engine is distributed under Apache License 2.0. Keep `LICENSE.txt` and `NOTICE.txt` with the packaged runtime.
