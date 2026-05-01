import subprocess
import time
import os

def start_node(config_path, log_file):
    print(f"Starting node with {config_path}...")
    with open(log_file, "w") as f:
        p = subprocess.Popen(["./node", "-config", config_path], cwd="../axl", stdout=f, stderr=f)
    return p

if __name__ == "__main__":
    os.makedirs("logs", exist_ok=True)
    p_a = start_node("../axl_integration/nodeA-config.json", "logs/nodeA.log")
    p_b = start_node("../axl_integration/nodeB-config.json", "logs/nodeB.log")
    
    try:
        print("Nodes started. Press Ctrl+C to stop.")
        while True:
            time.sleep(1)
            if p_a.poll() is not None:
                print(f"Node A died with exit code {p_a.returncode}")
                break
            if p_b.poll() is not None:
                print(f"Node B died with exit code {p_b.returncode}")
                break
    except KeyboardInterrupt:
        pass
    finally:
        p_a.terminate()
        p_b.terminate()
        print("Nodes stopped.")
