"""
config.py — 全組共用設定
修改前請先通知所有組員，這個檔案的改動影響全部模組。
"""

# 畫布尺寸
CANVAS_W = 1920
CANVAS_H = 1080

# 攝影機
CAM_INDEX = 0          # 外接攝影機通常是 1，內建是 0

# 輸出
OUTPUT_DIR = "outputs/"

# 效能目標
FPS_TARGET = 30

# MediaPipe 最低信心值，低於此不輸出座標
MIN_CONFIDENCE = 0.7

# 筆觸映射範圍
SPEED_MIN = 50         # px/s，低於此視為靜止
SPEED_MAX = 800        # px/s，高於此視為最快
THICKNESS_MIN = 2      # 最細筆觸（px）
THICKNESS_MAX = 20     # 最粗筆觸（px）

# 平滑係數（EMA）：越大越平滑但反應越慢
SMOOTH_FACTOR = 0.7

# 四種風格名稱
STYLES = ["油畫", "素描", "水墨", "名畫風"]
