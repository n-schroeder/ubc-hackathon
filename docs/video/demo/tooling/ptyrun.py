import os, pty, sys, fcntl, termios, struct
cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", cmd])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
while True:
    try:
        d = os.read(fd, 65536)
    except OSError:
        break
    if not d:
        break
    os.write(1, d)
_, st = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(st))
