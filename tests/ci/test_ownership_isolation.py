"""Keep the installer's synthetic isolation checks in the required CI suite."""
import importlib.util
from pathlib import Path

source = Path(__file__).resolve().parents[2]/'scripts/test-ownership-isolation-receipts.py'
spec = importlib.util.spec_from_file_location('isolation_checks', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
IsolationTests = module.IsolationTests
