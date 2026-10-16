"""Read-only reconstruction of the retained upstream FSX failure."""
import pathlib,sqlite3,struct,hashlib,json,sys,tempfile
profile=pathlib.Path(sys.argv[1]).resolve()
report=json.loads((profile/'report.json').read_text())
volume=profile/'volumes'/report['results'][0]['volumeId']
db=sqlite3.connect((volume/'meta.db').as_uri()+'?mode=ro',uri=True)
db.text_factory=bytes
inode,length=db.execute("select n.inode,n.length from jfs_node n join jfs_edge e on e.inode=n.inode where cast(e.name as text)='fsxtest'").fetchone()
slices=db.execute('select slices from jfs_chunk where inode=? and indx=0',(inode,)).fetchone()[0]
slices=[dict(zip(['pos','id','size','off','len'],struct.unpack('>IQIII',slices[i:i+24]))) for i in range(0,len(slices),24)]
db.close()
assert slices==[dict(pos=0,id=285,size=100000,off=0,len=100000),dict(pos=25248,id=0,size=0,off=0,len=74752),dict(pos=49152,id=286,size=49152,off=0,len=49152)]
sha=lambda b:hashlib.sha256(b).hexdigest()
blocks={}; comparisons=[]
for s in slices:
    if not s['id']:continue
    name=f"{s['id']}_0_{s['size']}"
    a=list((volume/'cache-upstream-1').rglob(name));b=list((volume/'cache').rglob(name))
    assert len(a)==len(b)==1
    warm=a[0].read_bytes();cold=b[0].read_bytes()
    assert warm==cold
    # JuiceFS appends a CRC32C trailer to cached raw data; payload is first size bytes.
    blocks[s['id']]=cold[:s['size']]
    comparisons.append(dict(name=name,payloadSize=s['size'],cacheSize=len(warm),cacheSha256=sha(warm),warmEqualsCold=True))
reconstructed=bytearray(100000)
for s in slices:
    reconstructed[s['pos']:s['pos']+s['len']]=bytes(s['len']) if not s['id'] else blocks[s['id']][s['off']:s['off']+s['len']]
warm=blocks[285][:25248];cold=bytes(reconstructed[:length])
assert sha(warm)=='cefe5d986341da7b84bdf5afbbd5844dc3ca41ec44e70fe1bf7ebff3cdf56c24'
assert sha(cold)=='1e494cef93b0b179e78b755ff6c9611291032625471849baac068614b628ac84'
assert cold[:len(warm)]==warm
assert cold[25248:49152]==bytes(49152-25248)
assert blocks[286][52828-49152:96752-49152]==struct.pack('<I',206)*((96752-52828)//4)
dest=pathlib.Path(tempfile.mkdtemp(prefix='juicefs-fsx-forensics-',dir=profile.parent))
(dest/'reconstructed-warm.bin').write_bytes(warm)
(dest/'reconstructed-cold.bin').write_bytes(cold)
result=dict(source=profile.name,inode=inode,slices=slices,blocks=comparisons,
    warm=dict(bytes=len(warm),sha256=sha(warm)),cold=dict(bytes=len(cold),sha256=sha(cold)),
    preservedPrefix=True,zeroGap=[25248,49152],lateWrite=[49152,98304],mappedWriteOperation=206,
    bothOriginalDigestsReproduced=True)
(dest/'report.json').write_text(json.dumps(result,indent=2))
print(json.dumps(dict(directory=str(dest),**result),indent=2))
