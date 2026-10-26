"""加载 config.yaml 供各模块共用"""
import yaml
from pathlib import Path

CFG = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text(encoding="utf-8"))
