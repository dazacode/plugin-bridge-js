(function(){
  var dmca = ["a1.example.invalid", "a2.example.invalid"];
  var main = ["m1.example.invalid", "m2.example.invalid"];
  var rules = ["r1.example.invalid"];
  var h = window.location.hostname;
  if (rules.indexOf(h) >= 0) { window.location.hostname = main[Math.floor(Math.random()*main.length)]; }
  else { window.location.hostname = dmca[Math.floor(Math.random()*dmca.length)]; }
})();
