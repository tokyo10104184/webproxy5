const form=document.getElementById('proxy-form');
const urlInput=document.getElementById('url-input');
const frame=document.getElementById('content-frame');
const clearBtn=document.getElementById('clear-button');
form.addEventListener('submit',(e)=>{
    e.preventDefault();
    let url=urlInput.value.trim();
    if(!url)return;
    if(!url.startsWith('http'))url='https://'+url;
    frame.src=`/proxy?url=${encodeURIComponent(url)}`;
});
clearBtn.addEventListener('click',()=>{urlInput.value='';frame.src='about:blank';});