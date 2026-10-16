import os,sys,json,time,mmap,hashlib
name=sys.argv[1]
def event(name,**data):
    print(json.dumps(dict(event=name,time=time.time(),**data)),flush=True)
with open(name,'w+b',buffering=0) as f:
    f.write(bytes((i*17+3)%256 for i in range(100000)))
    os.fsync(f.fileno())
    event('baseline')
    sys.stdin.readline()
    mm=mmap.mmap(f.fileno(),0)
    mm[52828:96752]=b'X'*(96752-52828)
    mm.flush()
    mm.close()
    event('mapped_write_flushed')
    start=time.monotonic()
    try:
        os.ftruncate(f.fileno(),25248)
        event('truncate_returned',elapsed=time.monotonic()-start,size=os.fstat(f.fileno()).st_size)
    except OSError as e:
        event('truncate_failed',elapsed=time.monotonic()-start,winerror=getattr(e,'winerror',None),errno=e.errno)
    sys.stdin.readline()
    os.fsync(f.fileno())
event('closed',size=os.stat(name).st_size)
