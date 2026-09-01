# jqweb
Renders json like jq, but as a webpage

## Example
<img src="demo.png" alt="jqweb rendering the Wikipedia REST API spec" width="600" align="right">

**Quick view of json output. (See screenshot on right)**
```
$ curl -s 'https://en.wikipedia.org/api/rest_v1/?spec' | ./jqweb
jqweb: serving on http://127.0.0.1:52748/ (Ctrl-C to stop)
```

**Output to an html file for offline viewing**
```bash
$ kubectl get pods -o json | jqweb -o k8s.html
$ open k8s.html # Opens webpage in your browser
```

**Specify port and host**
```bash
$ jqweb --host 0.0.0.0 --port 9000 < input.json
jqweb: serving on http://[::]:9000/ (Ctrl-C to stop)
```
<br clear="right">

## Why?

Sometimes it's easier to view it in your webbrowser then search through large json output to
find the exact value you need, especially if you don't know the json path.

## License

MIT Copyright Nick Clifford
