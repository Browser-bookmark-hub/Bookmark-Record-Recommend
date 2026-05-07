import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

def add_rounded_corners(im, rad):
    circle = Image.new('L', (rad * 2, rad * 2), 0)
    draw = ImageDraw.Draw(circle)
    draw.ellipse((0, 0, rad * 2 - 1, rad * 2 - 1), fill=255)
    alpha = Image.new('L', im.size, 255)
    w, h = im.size
    alpha.paste(circle.crop((0, 0, rad, rad)), (0, 0))
    alpha.paste(circle.crop((rad, 0, rad * 2, rad)), (w - rad, 0))
    alpha.paste(circle.crop((0, rad, rad, rad * 2)), (0, h - rad))
    alpha.paste(circle.crop((rad, rad, rad * 2, rad * 2)), (w - rad, h - rad))
    im.putalpha(alpha)
    return im

def add_top_rounded_corners(im, rad):
    circle = Image.new('L', (rad * 2, rad * 2), 0)
    draw = ImageDraw.Draw(circle)
    draw.ellipse((0, 0, rad * 2 - 1, rad * 2 - 1), fill=255)
    alpha = Image.new('L', im.size, 255)
    w, h = im.size
    alpha.paste(circle.crop((0, 0, rad, rad)), (0, 0))
    alpha.paste(circle.crop((rad, 0, rad * 2, rad)), (w - rad, 0))
    # Bottom corners remain square (full alpha)
    im.putalpha(alpha)
    return im

def add_premium_shadow(im, shadow_blur=40, offset=(0, 15), alpha=60):
    w, h = im.size
    total_width = w + shadow_blur * 2 + abs(offset[0])
    total_height = h + shadow_blur * 2 + abs(offset[1])
    
    shadow = Image.new('RGBA', (total_width, total_height), (0,0,0,0))
    draw = ImageDraw.Draw(shadow)
    
    shadow_box = (
        shadow_blur + max(0, offset[0]), 
        shadow_blur + max(0, offset[1]), 
        shadow_blur + max(0, offset[0]) + w, 
        shadow_blur + max(0, offset[1]) + h
    )
    # Shrink the shadow base slightly to make it look more like a diffuse glow
    shrink = 4
    shrunk_box = (shadow_box[0]+shrink, shadow_box[1]+shrink, shadow_box[2]-shrink, shadow_box[3]-shrink)
    draw.rectangle(shrunk_box, fill=(0, 0, 0, alpha))
    shadow = shadow.filter(ImageFilter.GaussianBlur(shadow_blur))
    shadow.paste(im, (shadow_blur + max(0, -offset[0]), shadow_blur + max(0, -offset[1])), im)
    return shadow

def resize_and_crop(im, target_size):
    target_w, target_h = target_size
    target_ratio = target_w / target_h
    im_ratio = im.width / im.height
    
    if im_ratio > target_ratio:
        new_w = int(im.height * target_ratio)
        offset = (im.width - new_w) // 2
        im = im.crop((offset, 0, offset + new_w, im.height))
    else:
        new_h = int(im.width / target_ratio)
        offset = (im.height - new_h) // 2
        im = im.crop((0, offset, im.width, offset + new_h))
    
    return im.resize(target_size, Image.Resampling.LANCZOS)

def generate_promo(bg_path, icon_path, ui_path, title_text, subtitle_text, output_path, font_title_path, font_sub_path, font_title_index=0, font_sub_index=0, spacing=22, title_offset_y=0, block_offset_y=0, title_size=52, sub_size=28):
    # 1. Background
    bg = Image.open(bg_path).convert("RGBA")
    bg = resize_and_crop(bg, (1280, 800))
    bg_w, bg_h = bg.size
    
    # 2. Icon
    icon = Image.open(icon_path).convert("RGBA")
    icon_size = 100
    icon = icon.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    icon = add_rounded_corners(icon, 22)
    # Removing shadow for icon as requested
    icon_shadowed = icon
    
    # 3. UI Screenshot
    ui = Image.open(ui_path).convert("RGBA")
    target_ui_width = 960
    ui_ratio = ui.height / ui.width
    target_ui_height = int(target_ui_width * ui_ratio)
    ui = ui.resize((target_ui_width, target_ui_height), Image.Resampling.LANCZOS)
    ui = add_top_rounded_corners(ui, 12)
    # Removing shadow as requested by the user
    ui_shadowed = ui
    
    # Positioning
    # Icon moved to top-left corner
    icon_x = 40
    icon_y = 40
    
    final_img = Image.new("RGBA", (bg_w, bg_h))
    final_img.paste(bg, (0, 0))
    final_img.paste(icon_shadowed, (icon_x, icon_y), icon_shadowed)
    
    # Text
    draw = ImageDraw.Draw(final_img)
    try:
        # Load the provided fonts, fallback to default if missing
        font_title = ImageFont.truetype(font_title_path, title_size, index=font_title_index)
        font_sub = ImageFont.truetype(font_sub_path, sub_size, index=font_sub_index)
    except:
        font_title = ImageFont.load_default()
        font_sub = ImageFont.load_default()
            
    # UI screenshot pushed down to exactly touch the bottom edge
    ui_y = bg_h - ui_shadowed.height
    ui_x = (bg_w - ui_shadowed.width) // 2

    # Calculate text block height to center it vertically above the UI screenshot
    available_space = ui_y
    
    title_bbox = draw.textbbox((0, 0), title_text, font=font_title)
    title_w = title_bbox[2] - title_bbox[0]
    title_h = title_bbox[3] - title_bbox[1]
    
    if subtitle_text:
        sub_bbox = draw.textbbox((0, 0), subtitle_text, font=font_sub)
        sub_w = sub_bbox[2] - sub_bbox[0]
        sub_h = sub_bbox[3] - sub_bbox[1]
        total_text_h = title_h + spacing + sub_h
    else:
        total_text_h = title_h
        
    # Center text block in the space above the screenshot and apply block_offset_y
    title_y = (available_space - total_text_h) // 2 + block_offset_y
    title_x = (bg_w - title_w) // 2
    
    # Clean text rendering (boldness comes from the font itself)
    # title_offset_y is subtracted so positive values move the title UP
    draw.text((title_x, title_y - title_offset_y), title_text, font=font_title, fill=(20, 20, 20, 255))
    
    if subtitle_text:
        sub_x = (bg_w - sub_w) // 2
        sub_y = title_y + title_h + spacing
        
        # Draw a subtle grey pill (mask) behind the subtitle
        pill_pad_x = 24
        pill_pad_y = 12
        pill_box = (
            sub_x - pill_pad_x, 
            sub_y + sub_bbox[1] - pill_pad_y, 
            sub_x + sub_w + pill_pad_x, 
            sub_y + sub_bbox[3] + pill_pad_y
        )
        # To draw transparent shapes properly in PIL, we need an overlay layer
        overlay = Image.new('RGBA', final_img.size, (0, 0, 0, 0))
        overlay_draw = ImageDraw.Draw(overlay)
        try:
            overlay_draw.rounded_rectangle(pill_box, radius=(sub_bbox[3] - sub_bbox[1] + pill_pad_y * 2) // 2, fill=(0, 0, 0, 25))
        except AttributeError:
            # Fallback for older Pillow versions
            overlay_draw.rectangle(pill_box, fill=(0, 0, 0, 25))
            
        final_img = Image.alpha_composite(final_img, overlay)
        
        # We need to re-bind the draw object since final_img is a new composited instance
        draw = ImageDraw.Draw(final_img)
        draw.text((sub_x, sub_y), subtitle_text, font=font_sub, fill=(35, 35, 35, 255))
        
    final_img.paste(ui_shadowed, (ui_x, ui_y), ui_shadowed)
    
    final_img.convert("RGB").save(output_path, quality=95)
    print(f"Saved {output_path}")

if __name__ == '__main__':
    base_dir = "/Users/kk/Downloads/kk/record & recommend/Bookmark-Record-Recommend/Screenshots and icons"
    bg_path = os.path.join(base_dir, "背景图.png")
    icon_path = os.path.join(base_dir, "icons", "R.jpg")
    
    in_dir = os.path.join(base_dir, "v0.3")
    out_dir = os.path.join(in_dir, "assets")
    os.makedirs(out_dir, exist_ok=True)

    # English Version (Push & Analyze)
    generate_promo(
        bg_path=bg_path,
        icon_path=icon_path,
        ui_path=os.path.join(in_dir, "推送与分析 en.png"),
        title_text="AI Push & Analyze",
        subtitle_text="Export local computations to GitHub for seamless, out-of-the-box AI analysis",
        output_path=os.path.join(out_dir, "推送与分析 en.png"),
        font_title_path="/System/Library/Fonts/HelveticaNeue.ttc",
        font_sub_path="/System/Library/Fonts/HelveticaNeue.ttc",
        font_title_index=1,
        font_sub_index=0,
        spacing=30,
        title_offset_y=8,
        block_offset_y=5,
        title_size=46,
        sub_size=24
    )
    
    # Chinese Version (Push & Analyze)
    generate_promo(
        bg_path=bg_path,
        icon_path=icon_path,
        ui_path=os.path.join(in_dir, "推送与分析 zh.png"),
        title_text="AI 推送与分析",
        subtitle_text="本地完成复杂计算并推送到云端，让 AI 深度分析开箱即用",
        output_path=os.path.join(out_dir, "推送与分析 zh.png"),
        font_title_path="/System/Library/Fonts/Hiragino Sans GB.ttc",
        font_sub_path="/System/Library/Fonts/Hiragino Sans GB.ttc",
        font_title_index=2,
        font_sub_index=0,
        spacing=22,
        title_size=48,
        sub_size=26
    )

    generate_promo(
        bg_path=bg_path,
        icon_path=icon_path,
        ui_path=os.path.join(in_dir, "书签记录 en.png"),
        title_text="Bookmark Records",
        subtitle_text="Comprehensive tracking including addition logs, click rankings, related records, and time tracking",
        output_path=os.path.join(out_dir, "书签记录 en.png"),
        font_title_path="/System/Library/Fonts/HelveticaNeue.ttc",
        font_sub_path="/System/Library/Fonts/HelveticaNeue.ttc",
        font_title_index=1,
        font_sub_index=0,
        spacing=28,
        title_offset_y=8,
        block_offset_y=35,
        title_size=46,
        sub_size=21
    )

    generate_promo(
        bg_path=bg_path,
        icon_path=icon_path,
        ui_path=os.path.join(in_dir, "书签记录 zh.png"),
        title_text="多维书签记录",
        subtitle_text="全面涵盖添加记录、点击排行、关联记录及时间捕捉与排行",
        output_path=os.path.join(out_dir, "书签记录 zh.png"),
        font_title_path="/System/Library/Fonts/Hiragino Sans GB.ttc",
        font_sub_path="/System/Library/Fonts/Hiragino Sans GB.ttc",
        font_title_index=2,
        font_sub_index=0,
        spacing=22,
        block_offset_y=35,
        title_size=48,
        sub_size=26
    )
