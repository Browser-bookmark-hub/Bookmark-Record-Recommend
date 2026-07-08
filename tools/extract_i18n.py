#!/usr/bin/env python3
import os

def main():
    # Base paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)
    
    js_path = os.path.join(repo_root, "Bookmark-Record-Recommend-main", "history_html", "history.js")
    html_path = os.path.join(repo_root, "Bookmark-Record-Recommend-main", "history_html", "history.html")
    i18n_path = os.path.join(repo_root, "Bookmark-Record-Recommend-main", "history_html", "history_i18n.js")
    
    print(f"JS Path: {js_path}")
    print(f"HTML Path: {html_path}")
    print(f"i18n Path: {i18n_path}")
    
    if not os.path.exists(js_path):
        print(f"Error: {js_path} does not exist!")
        return
        
    with open(js_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    idx_ii = -1
    idx_iii = -1
    
    for idx, line in enumerate(lines):
        # Only look for the section headers, not in the table of contents (which is at the very beginning, lines 1-20)
        if idx < 50:
            continue
        cleaned = line.strip()
        if cleaned == "// II. LOCALIZATION & TRANSLATIONS (国际化文本定义)":
            idx_ii = idx
        elif cleaned == "// III. CORE DATA UTILITIES & HELPERS (核心数据库/数据加载服务与 URL 辅助函数)":
            idx_iii = idx
            break  # We only need these two
            
    if idx_ii == -1:
        print("Error: Could not find Section II header in history.js!")
        return
    if idx_iii == -1:
        print("Error: Could not find Section III header in history.js!")
        return
        
    # Section II start index should include the preceding separator line
    start_idx = idx_ii
    if start_idx > 0 and lines[start_idx-1].strip().startswith("// =="):
        start_idx -= 1
        
    # Section III start index should include the preceding separator line
    end_idx = idx_iii
    if end_idx > 0 and lines[end_idx-1].strip().startswith("// =="):
        end_idx -= 1
        
    print(f"Section II start index (0-based line): {start_idx}")
    print(f"Section III start index (0-based line): {end_idx}")
    
    # Extract Section II lines
    sec2_lines = lines[start_idx:end_idx]
    
    # Save to i18n.js
    with open(i18n_path, "w", encoding="utf-8") as f:
        f.writelines(sec2_lines)
    print(f"Successfully wrote {i18n_path}")
    
    # Modify history.js content
    # We replace Section II with a placeholder header
    replacement_lines = [
        "// =================================================================================\n",
        "// II. LOCALIZATION & TRANSLATIONS (国际化文本定义) - MOVED TO history_i18n.js\n",
        "// =================================================================================\n\n\n"
    ]
    
    new_lines = lines[:start_idx] + replacement_lines + lines[end_idx:]
    with open(js_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)
    print(f"Successfully updated {js_path}")
    
    # Modify history.html
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            html_content = f.read()
            
        script_tag = '<script src="history.js" defer></script>'
        i18n_tag = '<script src="history_i18n.js" defer></script>'
        
        if i18n_tag in html_content:
            print("i18n.js is already referenced in history.html")
        elif script_tag in html_content:
            html_content = html_content.replace(script_tag, f"{i18n_tag}\n    {script_tag}")
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(html_content)
            print("Successfully updated history.html")
        else:
            print("Warning: history.js script tag not found in history.html")
    else:
        print(f"Warning: {html_path} does not exist")

if __name__ == "__main__":
    main()
