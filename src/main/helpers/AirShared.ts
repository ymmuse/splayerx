import { OpenDialogReturnValue, splayerx, dialog } from 'electron';
import path from 'path';
import http from 'http';
import url from 'url';
import fs from 'fs';
import os from 'os';

import { getValidVideoExtensions } from '../../shared/utils';

/* eslint-disable */
// Refer Examples at https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
function encodeRFC5987ValueChars(str: string) {
  return encodeURIComponent(str).
    // Note that although RFC3986 reserves "!", RFC5987 does not,
    // so we do not need to escape it
    replace(/['()]/g, escape). // i.e., %27 %28 %29
    replace(/\*/g, '%2A').
        // The following are not required for percent-encoding per RFC5987,
        // so we can allow for a little better readability over the wire: |`^
        replace(/%(?:7C|60|5E)/g, unescape);
}

/* eslint-enable */

function ipToInt(ip: string): number {
  return ip.split('.').map((val, idx, arr) => parseInt(val, 10) * (256 ** (arr.length - idx - 1))).reduce((prev, curr) => prev + curr);
}

function getLocalIP(): string[] {
  const ips: string[] = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((ifname) => {
    ifaces[ifname].forEach((iface) => {
      if (iface.family !== 'IPv4' || iface.internal !== false) {
        // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
        return;
      }
      ips.push(iface.address);
    });
  });
  return ips;
}

class SharedFile {
  private stat: fs.Stats;

  private filepath: string;

  public constructor(file: string) {
    this.stat = fs.statSync(file);
    this.filepath = file;
  }

  public getFileName(): string {
    return path.basename(this.filepath);
  }

  public fileSize(): number {
    return this.stat.size;
  }

  public getWholeContent(): fs.ReadStream {
    return fs.createReadStream(this.filepath);
  }

  public getPartialContent(start: number, end: number): fs.ReadStream {
    return fs.createReadStream(this.filepath, { start, end });
  }

  public filenameEncodeRFC5987(): string {
    return encodeRFC5987ValueChars(path.basename(this.filepath));
  }
}

class SharedRequest {
  public enableRange: boolean;

  public rangeStart: number;

  public rangeEnd: number;

  private request: http.IncomingMessage;

  public constructor(req: http.IncomingMessage) {
    this.request = req;
    this.parseRange();
  }

  private parseRange() {
    this.enableRange = false;
    if (this.request.headers['range']) {
      const parts = this.request.headers.range.replace(/bytes=/, '').split('-');
      this.rangeStart = parseInt(parts[0], 10);
      this.rangeEnd = parts[1] ? parseInt(parts[1], 10) : -1;
      this.enableRange = true;
    }
  }
}

class SharedResponse {
  private sf: SharedFile;

  private response: http.ServerResponse;

  public constructor(res: http.ServerResponse) {
    this.response = res;
  }

  public setSharedFile(filepath: string): boolean {
    const ok = fs.existsSync(filepath);
    if (!ok) {
      return false;
    }
    this.sf = new SharedFile(filepath);
    return true;
  }

  public sharedWhole() {
    const filename = this.sf.filenameEncodeRFC5987();
    this.response.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${filename}`,
    );
    this.sf.getWholeContent().pipe(this.response);
  }

  public sharedRange(start: number, end: number) {
    const filename = this.sf.filenameEncodeRFC5987();
    const filesize = this.sf.fileSize();
    if (end <= 0) {
      end = filesize - 1;
    }
    const chunksize = (end - start) + 1;

    this.response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${filesize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'content-disposition': `attachment; filename*=UTF-8''${filename}`,
    });
    this.sf.getPartialContent(start, end).pipe(this.response);
  }

  public notFound() {
    this.response.writeHead(404);
    this.response.end();
  }

  public abort() {
    this.response.writeHead(500);
    this.response.end();
  }

  public streamingInfo() {
    const rspinfo = {
      filename: this.sf.getFileName(),
      device: 'PC',
      model: 'PC',
    };
    this.response.setHeader('Content-Type', 'application/json');
    this.response.end(JSON.stringify(rspinfo));
  }

  public heartbeat() {
    this.response.writeHead(200);
    this.response.end();
  }
}

class AirShared {
  private httpServer: http.Server;

  private enableAirShared: boolean = false;

  public isServiceEnable(): boolean {
    return this.enableAirShared;
  }

  // eslint-disable-next-line
  public onClickAirShared(menuService: any) {
    if (process.platform !== 'darwin') return;
    if (!this.enableAirShared) {
      dialog.showOpenDialog({
        title: 'Air Shared',
        filters: [{
          name: 'Video Files',
          extensions: getValidVideoExtensions(),
        }, {
          name: 'All Files',
          extensions: ['*'],
        }],
        properties: ['openFile'],
        securityScopedBookmarks: process.mas,
      }).then((ret: OpenDialogReturnValue) => {
        if (ret.filePaths.length > 0) {
          this.enableAirShared = !this.enableAirShared;
          // start air shared
          this.enableService(ret.filePaths[0]);
        } else {
          menuService.updateMenuItemChecked('file.airShared', false);
        }
      }).catch((error: Error) => {
        console.error('trying to start AirShared.', error);
      });
    } else { // stop air shared
      this.enableAirShared = !this.enableAirShared;
      this.disableService();
    }
  }

  public onAppExit() {
    this.disableService();
    this.enableAirShared = false;
  }

  private enableService(sharedfile: string) {
    if (process.platform !== 'darwin') return;
    const port = 62020;
    const host = this.startHttpServer(sharedfile, port);
    if (host) {
      // the ip need translate to code
      const code = ipToInt(host);
      console.info('enable shared service for file: ', host, code);
      splayerx.startBluetoothService(`s${code}p`, `http://${host}:${port}/`);
    }
  }

  private disableService() {
    if (process.platform !== 'darwin') return;
    console.info('disable shared service.');
    if (this.httpServer) {
      this.httpServer.close();
    }
    splayerx.stopBluetoothService();
  }

  private getValidIP(): string|null {
    // Need a better way to find a valid IP
    const ips = getLocalIP();
    let theip = ips.length > 0 ? ips[0] : null;
    ips.forEach((ip) => {
      const arr = ip.split('.');
      if (arr.length === 4 && arr[0] === '192') {
        theip = ip;
      }
    });
    return theip;
  }

  private startHttpServer(sharedfile: string, port: number): string|null {
    const ip = this.getValidIP();
    if (!ip) {
      return null;
    }

    const host = ip;
    const sharedfilename = path.basename(sharedfile);
    const encodeFileanme = encodeURIComponent(sharedfilename);

    this.httpServer = http.createServer((req, res) => {
      const response = new SharedResponse(res);
      try {
        if (!response.setSharedFile(sharedfile) || !req.url) {
          response.notFound();
          return;
        }

        const parts = url.parse(req.url, true);
        if (parts.path === '/info') {
          response.streamingInfo();
          return;
        }
        if (parts.path === '/heartbeat') {
          response.heartbeat();
          return;
        }
        const request = new SharedRequest(req);
        if (request.enableRange) {
          response.sharedRange(request.rangeStart, request.rangeEnd);
          return;
        }
        response.notFound();
        return;
      } catch (ex) {
        console.error(ex);
        response.abort();
      }
    });
    this.httpServer.on('error', (err) => {
      console.error(err);
    });

    this.httpServer.listen(port, host);
    return host;
  }
}

const airSharedInstance = new AirShared();
export default airSharedInstance;
