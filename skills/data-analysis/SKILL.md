---
name: Data Analysis
description: Analyze data files (CSV, JSON, Excel) with Python
triggers: analyze data, data analysis, datenanalyse, csv, excel analysis, chart, graph, visualize, statistik, statistics
priority: 4
category: analysis
---

# Data Analysis Skill

When analyzing data files or creating visualizations:

## Workflow
1. **Read the file** — use Python (pandas) for CSV/Excel, or parse JSON directly
2. **Analyze YOURSELF** — describe patterns, trends, outliers in natural language
3. **Visualize** with matplotlib/seaborn if charts are requested
4. **Save outputs** to /tmp/ and deliver to the user

## Python Pattern
```python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("/path/to/data.csv")  # or pd.read_excel()
print(df.describe())
print(df.head(10))

# Visualization
fig, ax = plt.subplots(figsize=(10, 6))
df.plot(kind='bar', ax=ax)
plt.tight_layout()
plt.savefig('/tmp/chart.png', dpi=150)
```

## Guidelines
- Always show a quick summary first (rows, columns, types, missing values)
- Interpret results — don't just dump numbers, explain what they mean
- For large datasets: show head + describe, not the full data
- Charts: clean labels, readable fonts, meaningful titles
