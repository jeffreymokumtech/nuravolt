"""Quality Test Agent for ShamsIQ.

Two-part loop: `collect.py` drives Playwright/HTTP to gather artifacts,
then the `/qa-judge` slash command asks Claude Code to grade them.
"""
